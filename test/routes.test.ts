import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createRequire } from 'node:module';
import { SignJWT } from 'jose';
import * as schema from '../src/db/schema';

// drizzle-kit's API only loads as CommonJS
const { generateDrizzleJson, generateMigration } = createRequire(import.meta.url)(
  'drizzle-kit/api',
) as typeof import('drizzle-kit/api');

// The routes run against an in-memory Postgres built from the real schema.
const client = new PGlite();
const testDb = drizzle(client);
vi.mock('../src/db', () => ({ getDb: () => testDb }));

// Emails are recorded, not sent
const sentMails: Array<{ to: string; subject: string }> = [];
vi.mock('../src/mail', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/mail')>();
  return {
    ...real,
    sendMail: vi.fn(async (_env: unknown, mail: { to: string; subject: string }) => {
      sentMails.push({ to: mail.to, subject: mail.subject });
      return true;
    }),
    // What the test button would send with (the real SMTP isn't reachable here)
    deliver: vi.fn(async (config: { user: string; pass: string }, mail: { to: string; subject: string }) => {
      if (config.pass !== 'abcdefghijklmnop') throw new Error('535 Authentication failed');
      sentMails.push({ to: mail.to, subject: `${mail.subject} via ${config.user}` });
    }),
  };
});

const { app } = await import('../src/index');

/** Minimal stand-in for the R2 bucket binding. */
function fakeBucket() {
  const objects = new Map<string, { bytes: ArrayBuffer; contentType?: string }>();
  return {
    objects,
    async put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
      const bytes = value instanceof Uint8Array ? (value.buffer.slice(0) as ArrayBuffer) : value;
      objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType });
    },
    async list({ prefix }: { prefix: string }) {
      return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
    async get(key: string) {
      const found = objects.get(key);
      return found ? { body: found.bytes, httpMetadata: { contentType: found.contentType } } : null;
    },
    // Like R2: one key or a list of keys
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
}

const JWT_SECRET = 'test-secret';
let bucket = fakeBucket();
let token = '';

const env = () => ({
  DATABASE_URL: 'unused',
  JWT_SECRET,
  ALLOWED_ORIGINS: 'http://localhost:5174',
  R2_PUBLIC_URL: 'https://cdn.test',
  IMAGES: bucket,
});

function call(path: string, init: RequestInit = {}, auth = false) {
  const headers = new Headers(init.headers);
  if (auth) headers.set('Authorization', `Bearer ${token}`);
  if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');
  return app.request(path, { ...init, headers }, env());
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

const customer = { name: 'Ana', phone: '555', email: 'ana@cliente.test', address: 'Calle 1', city: 'Caracas', notes: '', paymentMethod: 'transfer' };

beforeAll(async () => {
  const statements = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema));
  for (const statement of statements) await client.exec(statement);
  token = await new SignJWT({ sub: '1', role: 'admin', username: 'ana' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET));
});

beforeEach(async () => {
  bucket = fakeBucket();
  sentMails.length = 0;
  await client.exec(`
    TRUNCATE password_resets, settings, contact_messages, orders, sales, stock_products, product_images, products, subcategories, categories, users RESTART IDENTITY CASCADE;
    INSERT INTO users (username, email, password_hash) VALUES ('ana', 'ana@test.dev', 'x');
    INSERT INTO categories (name, name_en, slug) VALUES ('Anillos', 'Rings', 'anillos');
    INSERT INTO subcategories (category_id, name, name_en, slug) VALUES (1, 'Oro', 'Gold', 'oro');
    INSERT INTO products (code, name, name_en, slug, category_id, subcategory_id, price, stock, active) VALUES
      ('A1', 'Anillo', 'Ring', 'anillo', 1, 1, 120.50, 5, true),
      ('C1', 'Collar', 'Necklace', 'collar', 1, 1, 80, 2, true),
      ('X1', 'Oculto', 'Hidden', 'oculto', 1, 1, 10, 9, false);
  `);
});

describe('POST /api/orders', () => {
  it('prices the order from the database and ignores client prices', async () => {
    const res = await call('/api/orders', json({
      ...customer,
      total: 1,
      items: [{ productId: 1, quantity: 2, price: 0.01 }, { productId: 2, quantity: 1 }],
    }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 1, total: 321, receiptUploaded: false });

    const list = await call('/api/orders', {}, true);
    const [order] = (await list.json()) as Array<Record<string, unknown>>;
    expect(order).toMatchObject({ customerName: 'Ana', total: 321, status: 'pending', paymentMethod: 'transfer' });
    expect(order.items).toEqual([
      { productId: 1, code: 'A1', name: 'Anillo', price: 120.5, quantity: 2, subtotal: 241 },
      { productId: 2, code: 'C1', name: 'Collar', price: 80, quantity: 1, subtotal: 80 },
    ]);
  });

  it('stores the transfer receipt and only serves it to the admin', async () => {
    const form = new FormData();
    form.append('data', JSON.stringify({ ...customer, items: [{ productId: 1, quantity: 1 }] }));
    form.append('receipt', new File([new Uint8Array([1, 2, 3])], 'pago.png', { type: 'image/png' }));

    const res = await call('/api/orders', { method: 'POST', body: form });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: 1, total: 120.5, receiptUploaded: true });
    expect([...bucket.objects.keys()]).toEqual([expect.stringMatching(/^receipts\/1\/[\w-]+\.png$/)]);

    expect((await call('/api/orders/1/receipt')).status).toBe(401);
    const receipt = await call('/api/orders/1/receipt', {}, true);
    expect(receipt.status).toBe(200);
    expect(receipt.headers.get('Content-Type')).toBe('image/png');
    expect(new Uint8Array(await receipt.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

    expect((await call('/api/orders/2/receipt', {}, true)).status).toBe(404);
  });

  it('rejects a receipt that is not an image or PDF', async () => {
    const form = new FormData();
    form.append('data', JSON.stringify({ ...customer, items: [{ productId: 1, quantity: 1 }] }));
    form.append('receipt', new File(['<script>'], 'x.html', { type: 'text/html' }));
    const res = await call('/api/orders', { method: 'POST', body: form });
    expect(res.status).toBe(400);
    expect(bucket.objects.size).toBe(0);
  });

  it.each([
    ['no items', { ...customer, items: [] }],
    ['missing name', { ...customer, name: ' ', items: [{ productId: 1, quantity: 1 }] }],
    ['bad quantity', { ...customer, items: [{ productId: 1, quantity: 0 }] }],
    ['bad payment method', { ...customer, paymentMethod: 'cash', items: [{ productId: 1, quantity: 1 }] }],
  ])('rejects an order with %s', async (_label, body) => {
    expect((await call('/api/orders', json(body))).status).toBe(400);
  });

  it('rejects products that are inactive or do not exist', async () => {
    expect((await call('/api/orders', json({ ...customer, items: [{ productId: 3, quantity: 1 }] }))).status).toBe(409);
    expect((await call('/api/orders', json({ ...customer, items: [{ productId: 99, quantity: 1 }] }))).status).toBe(409);
  });

  it('answers invalid JSON with 400', async () => {
    expect((await call('/api/orders', { method: 'POST', body: '{nope' })).status).toBe(400);
  });

  it('rejects quantities above the available stock', async () => {
    const res = await call('/api/orders', json({ ...customer, items: [{ productId: 2, quantity: 3 }] }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('Solo quedan 2');
    await client.exec(`UPDATE products SET stock = 0 WHERE id = 2`);
    const out = await call('/api/orders', json({ ...customer, items: [{ productId: 2, quantity: 1 }] }));
    expect(((await out.json()) as { error: string }).error).toContain('agotado');
  });

  it('takes stock when paid and returns it when cancelled', async () => {
    const stockOf = async (id: number) =>
      (await client.query<{ stock: number }>('SELECT stock FROM products WHERE id = $1', [id])).rows[0].stock;
    const patch = (status: string) =>
      call('/api/orders/1/status', { method: 'PATCH', body: JSON.stringify({ status }) }, true);
    await call('/api/orders', json({ ...customer, items: [{ productId: 1, quantity: 2 }, { productId: 2, quantity: 1 }] }));
    expect(await stockOf(1)).toBe(5); // a new order only checks stock

    expect((await patch('confirmed')).status).toBe(200);
    expect(await stockOf(1)).toBe(5);

    expect((await patch('paid')).status).toBe(200);
    expect(await stockOf(1)).toBe(3);
    expect(await stockOf(2)).toBe(1);
    const sales = (await (await call('/api/sales', {}, true)).json()) as Array<Record<string, unknown>>;
    expect(sales).toHaveLength(2);
    expect(sales.find((s) => s.productId === 1)).toMatchObject({ orderId: 1, unitPrice: 120.5, total: 241, notes: 'Pedido #1' });

    // paid -> shipped -> delivered keeps the stock as it is
    expect((await patch('shipped')).status).toBe(200);
    expect((await patch('delivered')).status).toBe(200);
    expect(await stockOf(1)).toBe(3);

    const cancelled = await patch('cancelled');
    expect(await cancelled.json()).toMatchObject({ status: 'cancelled' });
    expect(await stockOf(1)).toBe(5);
    expect(await stockOf(2)).toBe(2);
    expect(await (await call('/api/sales', {}, true)).json()).toEqual([]);
  });

  it('refuses to mark paid without enough stock', async () => {
    await call('/api/orders', json({ ...customer, items: [{ productId: 2, quantity: 2 }] }));
    await client.exec(`UPDATE products SET stock = 1 WHERE id = 2`);
    const res = await call('/api/orders/1/status', { method: 'PATCH', body: JSON.stringify({ status: 'paid' }) }, true);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('Collar');
    const [order] = (await (await call('/api/orders', {}, true)).json()) as Array<{ status: string }>;
    expect(order.status).toBe('pending');
  });

  it('keeps the order list and status changes behind login', async () => {
    expect((await call('/api/orders')).status).toBe(401);
    await call('/api/orders', json({ ...customer, items: [{ productId: 1, quantity: 1 }] }));
    const patch = (status: string) =>
      call('/api/orders/1/status', { method: 'PATCH', body: JSON.stringify({ status }) }, true);
    expect((await patch('bogus')).status).toBe(400);
    const ok = await patch('paid');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: 1, status: 'paid' });
  });
});

describe('products', () => {
  it('lists active products with their images in one response', async () => {
    await client.exec(`INSERT INTO product_images (product_id, filename, display_order) VALUES (1, 'b.png', 1), (1, 'a.png', 0)`);
    const res = await call('/api/products');
    const products = (await res.json()) as Array<{ id: number; price: number; images: Array<{ filename: string }> }>;
    expect(products.map((p) => p.id).sort()).toEqual([1, 2]);
    const ring = products.find((p) => p.id === 1)!;
    expect(ring.price).toBe(120.5);
    expect(ring.images.map((i) => i.filename)).toEqual(['a.png', 'b.png']);
    expect(products.find((p) => p.id === 2)!.images).toEqual([]);
    expect(ring).not.toHaveProperty('cost');
    expect(ring).not.toHaveProperty('minStock');
  });

  it('serves one product publicly without internal fields, and hides inactive ones', async () => {
    const res = await call('/api/products/anillo');
    expect(res.status).toBe(200);
    const ring = (await res.json()) as Record<string, unknown>;
    expect(ring).toMatchObject({ id: 1, stock: 5 });
    expect(ring).not.toHaveProperty('cost');
    expect((await call('/api/products/oculto')).status).toBe(404);
    expect((await call('/api/products/3')).status).toBe(404);
  });

  it('only updates fields that are allowed', async () => {
    const res = await call('/api/products/1', {
      method: 'PUT',
      body: JSON.stringify({ price: 150, id: 77, createdAt: '2000-01-01', nameEn: 'Ring' }),
    }, true);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 1, price: 150, name: 'Anillo', nameEn: 'Ring', stock: 5 });
  });

  it('does not store English texts (the site is translated in the browser)', async () => {
    const res = await call('/api/products/1', { method: 'PUT', body: JSON.stringify({ name: 'Anillo fino', nameEn: 'Gold band' }) }, true);
    expect(await res.json()).toMatchObject({ name: 'Anillo fino', nameEn: 'Ring' });
  });

  it('rejects invalid values and unknown ids', async () => {
    const put = (id: string, body: unknown) => call(`/api/products/${id}`, { method: 'PUT', body: JSON.stringify(body) }, true);
    expect((await put('1', { price: -5 })).status).toBe(400);
    expect((await put('1', { stock: 1.5 })).status).toBe(400);
    expect((await put('999', { price: 5 })).status).toBe(404);
    expect((await put('abc', { price: 5 })).status).toBe(404);
    expect((await call('/api/products/1', { method: 'PUT', body: '{}' })).status).toBe(401);
  });

  it('reports a duplicate code as a conflict', async () => {
    const res = await call('/api/products', json({
      code: 'A1', name: 'Otro', nameEn: 'Other', slug: 'otro', categoryId: 1, subcategoryId: 1, price: 5,
    }), true);
    expect(res.status).toBe(409);
  });
});

describe('POST /api/products/bulk', () => {
  const bulk = (products: unknown[]) => call('/api/products/bulk', json({ products }), true);
  const row = (extra: Record<string, unknown>) => ({ categoryId: 1, subcategoryId: 1, price: 10, ...extra });

  it('creates every row, translating and building unique slugs', async () => {
    const res = await bulk([
      row({ row: 2, code: 'B1', name: 'Anillo', description: 'Oro rosa', stock: 3, featured: true }),
      row({ row: 3, code: 'B2', name: 'Pulsera Año', cost: null, tax: 15 }),
    ]);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { created: number; products: Array<Record<string, unknown>> };
    expect(body.created).toBe(2);
    expect(body.products[0]).toMatchObject({
      code: 'B1', slug: 'anillo-2', description: 'Oro rosa', nameEn: '', descriptionEn: '', stock: 3, featured: true, active: true,
    });
    expect(body.products[1]).toMatchObject({ slug: 'pulsera-ano', description: '', tax: 15 });
  });

  it('inserts nothing and reports each bad row', async () => {
    await client.exec(`INSERT INTO categories (name, slug) VALUES ('Collares', 'collares')`);
    const res = await bulk([
      row({ row: 2, code: 'OK1', name: 'Bien' }),
      row({ row: 3, code: 'A1', name: 'Código existente' }),
      row({ row: 4, code: 'OK1', name: 'Repetido' }),
      row({ row: 5, code: 'Z1', name: 'Sin categoría', categoryId: 99, subcategoryId: 99 }),
      row({ row: 6, code: 'Z2', name: 'Sub ajena', categoryId: 2 }),
      row({ row: 7, code: 'Z3', name: 'Sin precio', price: undefined }),
    ]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Array<{ row: number; error: string }> };
    expect(body.errors.map((e) => e.row)).toEqual([3, 4, 5, 5, 6, 7]);
    expect(body.errors[0].error).toContain('ya existe');
    expect(body.errors[3].error).toContain('subcategoría 99 no existe');
    expect(body.errors[4].error).toContain('no pertenece');
    const list = (await (await call('/api/products/admin/all', {}, true)).json()) as unknown[];
    expect(list).toHaveLength(3);
  });

  it('validates a whole file without inserting when dryRun is set', async () => {
    const many = Array.from({ length: 50 }, (_, i) => row({ row: i + 2, code: `D${i}`, name: `D${i}` }));
    const ok = await call('/api/products/bulk', json({ dryRun: true, products: many }), true);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ valid: 50, errors: [] });
    const bad = await call('/api/products/bulk', json({ dryRun: true, products: [...many, row({ row: 52, code: 'C1', name: 'X' })] }), true);
    expect(bad.status).toBe(200);
    expect(await bad.json()).toEqual({ valid: 50, errors: [{ row: 52, error: 'el código "C1" ya existe' }] });
    const list = (await (await call('/api/products/admin/all', {}, true)).json()) as unknown[];
    expect(list).toHaveLength(3);
  });

  it('requires a session and limits the batch size', async () => {
    expect((await call('/api/products/bulk', json({ products: [row({ code: 'Q', name: 'Q' })] }))).status).toBe(401);
    expect((await bulk([])).status).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => row({ code: `M${i}`, name: `M${i}` }));
    expect((await bulk(many)).status).toBe(400);
  });
});

describe('sales and stock', () => {
  const stockOf = async (id: number) =>
    (await client.query<{ stock: number }>('SELECT stock FROM products WHERE id = $1', [id])).rows[0].stock;

  it('registers a multi-product sale in one request', async () => {
    const res = await call('/api/sales/batch', json({
      notes: 'mostrador',
      lines: [{ productId: 1, quantity: 2 }, { productId: 2, quantity: 1, unitPrice: 70 }],
    }), true);
    expect(res.status).toBe(201);
    const sales = (await res.json()) as Array<Record<string, unknown>>;
    expect(sales).toHaveLength(2);
    expect(sales.find((s) => s.productId === 1)).toMatchObject({ total: 241, notes: 'mostrador', soldBy: 'ana' });
    expect(await stockOf(1)).toBe(3);
    expect(await stockOf(2)).toBe(1);

    const report = (await (await call('/api/sales/report', {}, true)).json()) as Array<Record<string, unknown>>;
    expect(report[0]).toEqual({ productId: 1, productName: 'Anillo', totalQuantity: 2, totalRevenue: 241, salesCount: 1 });
  });

  it('sells nothing if one product lacks stock', async () => {
    const res = await call('/api/sales/batch', json({
      lines: [{ productId: 1, quantity: 1 }, { productId: 2, quantity: 5 }],
    }), true);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('Collar');
    expect(await stockOf(1)).toBe(5);
    expect((await (await call('/api/sales', {}, true)).json())).toEqual([]);
  });

  it('still accepts the single-product endpoint', async () => {
    const res = await call('/api/sales', json({ productId: 2, quantity: 2 }), true);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ productId: 2, quantity: 2, total: 160 });
    expect(await stockOf(2)).toBe(0);
  });

  it('applies stock movements', async () => {
    const res = await call('/api/stock', json({ productId: 1, quantity: 10, type: 'adjustment', notes: 'conteo' }), true);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ productId: 1, quantity: 5, newStock: 10, createdBy: 'ana' });
    expect((await call('/api/stock', json({ productId: 1, quantity: 1, notes: '' }), true)).status).toBe(400);
    expect((await call('/api/stock', json({ productId: 99, quantity: 1, notes: 'x' }), true)).status).toBe(404);
  });
});

describe('voiding a counter sale', () => {
  const stockOf = async (id: number) =>
    (await client.query<{ stock: number }>('SELECT stock FROM products WHERE id = $1', [id])).rows[0].stock;

  it('returns the units and removes the sale from reports', async () => {
    await call('/api/sales', json({ productId: 1, quantity: 2 }), true);
    expect(await stockOf(1)).toBe(3);
    expect((await call('/api/sales/1', { method: 'DELETE' })).status).toBe(401);
    const res = await call('/api/sales/1', { method: 'DELETE' }, true);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, productId: 1, quantity: 2, newStock: 5 });
    expect(await stockOf(1)).toBe(5);
    expect(await (await call('/api/sales/report', {}, true)).json()).toEqual([]);
    expect((await call('/api/sales/1', { method: 'DELETE' }, true)).status).toBe(404);
  });

  it('refuses sales that belong to a web order', async () => {
    await call('/api/orders', json({ ...customer, items: [{ productId: 1, quantity: 1 }] }));
    await call('/api/orders/1/status', { method: 'PATCH', body: JSON.stringify({ status: 'paid' }) }, true);
    const res = await call('/api/sales/1', { method: 'DELETE' }, true);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('pedido #1');
    expect(await stockOf(1)).toBe(4);
  });
});

describe('pending order count', () => {
  it('counts pending orders and reports the newest one', async () => {
    expect((await call('/api/orders/pending-count')).status).toBe(401);
    const empty = await call('/api/orders/pending-count', {}, true);
    expect(await empty.json()).toEqual({ count: 0, lastId: null });
    await call('/api/orders', json({ ...customer, items: [{ productId: 1, quantity: 1 }] }));
    await call('/api/orders', json({ ...customer, items: [{ productId: 2, quantity: 1 }] }));
    await call('/api/orders/1/status', { method: 'PATCH', body: JSON.stringify({ status: 'confirmed' }) }, true);
    expect(await (await call('/api/orders/pending-count', {}, true)).json()).toEqual({ count: 1, lastId: 2 });
  });
});

describe('order tracking', () => {
  it('shows the order only with the matching phone', async () => {
    await call('/api/orders', json({ ...customer, phone: '+58 (412) 555-1234', items: [{ productId: 2, quantity: 1 }] }));
    const ok = await call('/api/orders/track?id=1&phone=584125551234');
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ id: 1, status: 'pending', total: 80, items: [{ name: 'Collar', quantity: 1, subtotal: 80 }] });
    expect(body).not.toHaveProperty('customerAddress');
    expect(body).not.toHaveProperty('customerName');
    expect((await call('/api/orders/track?id=1&phone=584125559999')).status).toBe(404);
    expect((await call('/api/orders/track?id=2&phone=584125551234')).status).toBe(404);
    expect((await call('/api/orders/track?id=1&phone=')).status).toBe(404);
  });
});

describe('deleting products', () => {
  it('explains that a product with sales must be deactivated instead', async () => {
    await call('/api/sales', json({ productId: 1, quantity: 1 }), true);
    const res = await call('/api/products/1', { method: 'DELETE' }, true);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('Desactívalo');
    expect((await call('/api/products/2', { method: 'DELETE' }, true)).status).toBe(200);
  });
});

describe('users', () => {
  it('does not let the last admin delete or deactivate themselves', async () => {
    expect((await call('/api/users/1', { method: 'DELETE' }, true)).status).toBe(409);
    expect((await call('/api/users/1/toggle', { method: 'PATCH' }, true)).status).toBe(409);
    const list = (await (await call('/api/users', {}, true)).json()) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('passwordHash');
  });

  it('blocks tokens without the admin role', async () => {
    await client.exec("INSERT INTO users (username, email, password_hash, role) VALUES ('bob', 'bob@test.dev', 'x', 'staff')");
    const staff = await new SignJWT({ sub: '2', role: 'staff', username: 'bob' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(JWT_SECRET));
    const res = await app.request('/api/users', { headers: { Authorization: `Bearer ${staff}` } }, env());
    expect(res.status).toBe(403);
  });
});

describe('PayPal payments', () => {
  const report = (id: number, body: Record<string, unknown> = {}) =>
    call(`/api/orders/${id}/paypal`, json({ phone: '4125551234', captureId: '3C679366HH908993F', amount: 120.5, ...body }));
  const paypalOrder = (productId = 1, quantity = 1) =>
    call('/api/orders', json({ ...customer, phone: '412-555-1234', paymentMethod: 'paypal', items: [{ productId, quantity }] }));
  const stockOf = async (id: number) =>
    Number((await client.query<{ stock: number }>(`SELECT stock FROM products WHERE id = ${id}`)).rows[0].stock);
  const orderList = async () => (await (await call('/api/orders', {}, true)).json()) as Array<Record<string, unknown>>;

  it('takes the stock when the payment is reported and keeps only the first report', async () => {
    await paypalOrder(1, 2);
    sentMails.length = 0;
    const res = await report(1, { amount: 241 });
    expect(await res.json()).toEqual({ ok: true, stockShort: false });
    expect((await report(1, { captureId: '9AB12345678901234' })).status).toBe(409);
    const [order] = await orderList();
    expect(order).toMatchObject({ paymentRef: '3C679366HH908993F', paymentAmount: 241, status: 'review' });
    expect(await stockOf(1)).toBe(3);
    expect(sentMails.map((m) => m.to).sort()).toEqual(['alexandrajewelry2@gmail.com', 'ana@cliente.test']);
    const tracked = await (await call('/api/orders/track?id=1&phone=4125551234')).json();
    expect(tracked).toMatchObject({ status: 'review', paymentReported: true, canPay: false });

    // Verified: review -> paid keeps the stock; cancelling returns it
    const patch = (status: string) => call('/api/orders/1/status', { method: 'PATCH', body: JSON.stringify({ status }) }, true);
    expect((await patch('paid')).status).toBe(200);
    expect(await stockOf(1)).toBe(3);
    expect((await patch('cancelled')).status).toBe(200);
    expect(await stockOf(1)).toBe(5);
  });

  it('notes the payment but warns when the stock ran out meanwhile', async () => {
    await paypalOrder(2, 2);
    await client.exec('UPDATE products SET stock = 1 WHERE id = 2');
    sentMails.length = 0;
    expect(await (await report(1, { amount: 160 })).json()).toEqual({ ok: true, stockShort: true });
    const [order] = await orderList();
    expect(order).toMatchObject({ status: 'pending', paymentRef: '3C679366HH908993F' });
    expect(await stockOf(2)).toBe(1);
    expect(sentMails).toEqual([expect.objectContaining({ to: 'alexandrajewelry2@gmail.com', subject: expect.stringContaining('SIN STOCK') })]);
  });

  it('checks before paying: amount, sold out, expired', async () => {
    await paypalOrder(2, 1);
    const check = (id: number, phone = '4125551234') => call(`/api/orders/${id}/paypal/check`, json({ phone }));
    expect(await (await check(1)).json()).toEqual({ total: 80 });
    expect((await check(1, '000000')).status).toBe(404);
    await client.exec('UPDATE products SET stock = 0 WHERE id = 2');
    expect((await check(1)).status).toBe(409);
    await client.exec("UPDATE products SET stock = 2 WHERE id = 2; UPDATE orders SET created_at = now() - interval '25 hours'");
    expect((await check(1)).status).toBe(409);
  });

  it('rejects a wrong phone, a bad id, and orders that do not wait for PayPal', async () => {
    await paypalOrder();
    await call('/api/orders', json({ ...customer, phone: '412-555-1234', items: [{ productId: 1, quantity: 1 }] }));
    expect((await report(1, { phone: '999' })).status).toBe(404);
    expect((await report(9)).status).toBe(404);
    expect((await report(1, { captureId: 'abc; drop' })).status).toBe(400);
    expect((await report(2)).status).toBe(409);
    await call('/api/orders/1/status', { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) }, true);
    expect((await report(1)).status).toBe(409);
  });

  it('cancels PayPal orders unpaid after 24 hours and tells the customer', async () => {
    const { expireUnpaidPaypalOrders } = await import('../src/routes/orders');
    await paypalOrder(); // 1: old, unpaid -> cancelled
    await paypalOrder(); // 2: recent -> stays
    await call('/api/orders', json({ ...customer, items: [{ productId: 1, quantity: 1 }] })); // 3: transfer -> stays
    await paypalOrder(); // 4: old but paid -> stays
    await report(4);
    await client.exec("UPDATE orders SET created_at = now() - interval '25 hours' WHERE id IN (1, 3, 4)");
    sentMails.length = 0;
    expect(await expireUnpaidPaypalOrders(testDb as never, {})).toBe(1);
    const statuses = Object.fromEntries((await orderList()).map((o) => [o.id, o.status]));
    expect(statuses).toEqual({ 1: 'cancelled', 2: 'pending', 3: 'pending', 4: 'review' });
    expect(sentMails).toEqual([expect.objectContaining({ to: 'ana@cliente.test', subject: expect.stringContaining('cancelado') })]);
  });
});

describe('order emails', () => {
  it('requires a valid email and notifies the customer and the store', async () => {
    const bad = await call('/api/orders', json({ ...customer, email: 'no-es-correo', items: [{ productId: 1, quantity: 1 }] }));
    expect(bad.status).toBe(400);
    const { email: _omit, ...withoutEmail } = customer;
    expect((await call('/api/orders', json({ ...withoutEmail, items: [{ productId: 1, quantity: 1 }] }))).status).toBe(400);
    expect(sentMails).toEqual([]);

    await call('/api/orders', json({ ...customer, items: [{ productId: 1, quantity: 1 }] }));
    expect(sentMails.map((m) => m.to).sort()).toEqual(['alexandrajewelry2@gmail.com', 'ana@cliente.test']);

    sentMails.length = 0;
    const patch = (status: string) => call('/api/orders/1/status', { method: 'PATCH', body: JSON.stringify({ status }) }, true);
    await patch('confirmed');
    await patch('pending'); // no email going back
    await patch('shipped');
    expect(sentMails.map((m) => m.subject)).toEqual([
      expect.stringContaining('Confirmamos tu pedido'),
      expect.stringContaining('va en camino'),
    ]);
  });
});

describe('contact messages', () => {
  it('saves the message, emails the store and manages the inbox', async () => {
    const msg = { name: 'Luisa', email: 'luisa@test.dev', phone: '', message: 'Hola, ¿tienen tallas?' };
    expect((await call('/api/contact', json({ ...msg, email: 'mal' }))).status).toBe(400);
    expect((await call('/api/contact', json(msg))).status).toBe(201);
    expect(sentMails).toEqual([expect.objectContaining({ to: 'alexandrajewelry2@gmail.com' })]);

    expect((await call('/api/contact')).status).toBe(401);
    const inbox = (await (await call('/api/contact', {}, true)).json()) as Array<Record<string, unknown>>;
    expect(inbox).toEqual([expect.objectContaining({ id: 1, name: 'Luisa', read: false })]);
    expect(await (await call('/api/contact/unread-count', {}, true)).json()).toEqual({ count: 1 });

    await call('/api/contact/1/read', { method: 'PATCH', body: JSON.stringify({ read: true }) }, true);
    expect(await (await call('/api/contact/unread-count', {}, true)).json()).toEqual({ count: 0 });
    expect((await call('/api/contact/1', { method: 'DELETE' }, true)).status).toBe(200);
    expect((await call('/api/contact/1', { method: 'DELETE' }, true)).status).toBe(404);
  });
});

describe('email settings', () => {
  const put = (body: unknown, auth = true) => call('/api/settings/mail', { method: 'PUT', body: JSON.stringify(body) }, auth);

  it('stores the account with the password encrypted and never returns it', async () => {
    expect((await call('/api/settings/mail')).status).toBe(401);
    const empty = await (await call('/api/settings/mail', {}, true)).json();
    expect(empty).toMatchObject({ user: '', hasPassword: false, source: 'none' });

    expect((await put({ user: 'no-es-correo', password: 'x' })).status).toBe(400);
    expect((await put({ user: 'avisos@gmail.com' })).status).toBe(400); // no password yet
    expect((await put({ user: 'avisos@gmail.com', password: 'abcd efgh ijkl mnop' })).status).toBe(200);

    const raw = (await client.query<{ value: Record<string, unknown> }>("SELECT value FROM settings WHERE key = 'smtp'")).rows[0].value;
    expect(JSON.stringify(raw)).not.toContain('abcdefghijklmnop');
    expect(raw).toMatchObject({ user: 'avisos@gmail.com', host: 'smtp.gmail.com', port: 465 });

    const saved = await (await call('/api/settings/mail', {}, true)).json();
    expect(saved).toMatchObject({ user: 'avisos@gmail.com', hasPassword: true, source: 'panel', updatedBy: 'ana' });
    expect(JSON.stringify(saved)).not.toContain('abcdefghijklmnop');

    // Changing only the account keeps the saved password
    expect((await put({ user: 'otra@gmail.com' })).status).toBe(200);
    expect(await (await call('/api/settings/mail', {}, true)).json()).toMatchObject({ user: 'otra@gmail.com', hasPassword: true });
  });

  it('sends a test email with the saved account and explains failures', async () => {
    expect((await call('/api/settings/mail/test', json({}), true)).status).toBe(400); // nothing saved
    await put({ user: 'avisos@gmail.com', password: 'abcd efgh ijkl mnop' });
    const ok = await call('/api/settings/mail/test', json({ to: 'yo@test.dev' }), true);
    expect(await ok.json()).toEqual({ ok: true, to: 'yo@test.dev' });
    expect(sentMails).toEqual([expect.objectContaining({ to: 'yo@test.dev', subject: expect.stringContaining('via avisos@gmail.com') })]);

    await put({ user: 'avisos@gmail.com', password: 'equivocada' });
    const bad = await call('/api/settings/mail/test', json({}), true);
    expect(bad.status).toBe(502);
    expect(((await bad.json()) as { error: string }).error).toContain('contraseña de aplicación');
  });

  it('is for administrators only', async () => {
    await client.exec("INSERT INTO users (username, email, password_hash, role) VALUES ('leo', 'leo@test.dev', 'x', 'vendedor')");
    const seller = await new SignJWT({ sub: '2', role: 'vendedor', username: 'leo' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(JWT_SECRET));
    const res = await app.request('/api/settings/mail', { headers: { Authorization: `Bearer ${seller}` } }, env());
    expect(res.status).toBe(403);
  });
});

describe('PayPal settings', () => {
  const CLIENT_ID = 'BAA5lcZAIHMtX277l4BVwpmdykUt4Q8hYVjydKixc';
  const put = (body: unknown) => call('/api/settings/paypal', { method: 'PUT', body: JSON.stringify(body) }, true);
  const publicConfig = async () => (await (await call('/api/settings/public/payments')).json()) as { paypal: Record<string, unknown> };

  it('is not configured until the admin saves it', async () => {
    expect(await publicConfig()).toEqual({ paypal: { configured: false } });
    expect((await call('/api/settings/paypal')).status).toBe(401);
  });

  it('saves the Client ID and publishes it for the checkout', async () => {
    expect((await put({ enabled: true, clientId: 'corto' })).status).toBe(400);
    expect((await put({ enabled: true, clientId: CLIENT_ID })).status).toBe(200);
    expect(await publicConfig()).toEqual({ paypal: { configured: true, enabled: true, clientId: CLIENT_ID } });
    expect(await (await call('/api/settings/paypal', {}, true)).json()).toEqual({ configured: true, enabled: true, clientId: CLIENT_ID });
  });

  it('turning PayPal off hides it and rejects PayPal orders', async () => {
    await put({ enabled: false, clientId: CLIENT_ID });
    expect((await publicConfig()).paypal).toMatchObject({ enabled: false });
    const res = await call('/api/orders', json({ ...customer, paymentMethod: 'paypal', items: [{ productId: 1, quantity: 1 }] }));
    expect(res.status).toBe(400);
    expect((await call('/api/orders', json({ ...customer, items: [{ productId: 1, quantity: 1 }] }))).status).toBe(201);
  });
});

describe('sessions', () => {
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT({ sub: '1', role: 'admin', username: 'ana', ...claims })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(JWT_SECRET));
  const asToken = (t: string) => app.request('/api/orders', { headers: { Authorization: `Bearer ${t}` } }, env());

  it('ends when the user is turned off or the password changes', async () => {
    await client.exec("INSERT INTO users (username, email, password_hash) VALUES ('leo', 'leo@test.dev', 'x')");
    const leo = await new SignJWT({ sub: '2', role: 'admin', username: 'leo', tv: 0 })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(JWT_SECRET));
    expect((await asToken(leo)).status).toBe(200);

    await call('/api/users/2/password', { method: 'PATCH', body: JSON.stringify({ password: 'nueva-clave-123' }) }, true);
    expect((await asToken(leo)).status).toBe(401);

    const leoNew = await new SignJWT({ sub: '2', role: 'admin', username: 'leo', tv: 1 })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(JWT_SECRET));
    expect((await asToken(leoNew)).status).toBe(200);
    await call('/api/users/2/toggle', { method: 'PATCH' }, true);
    expect((await asToken(leoNew)).status).toBe(401);
  });

  it('takes the role from the database, not from the token', async () => {
    await client.exec("UPDATE users SET role = 'vendedor' WHERE id = 1");
    const res = await app.request('/api/users', { headers: { Authorization: `Bearer ${await sign({ role: 'admin' })}` } }, env());
    expect(res.status).toBe(403);
  });
});

describe('password reset', () => {
  it('emails a one-time link that sets a new password and ends old sessions', async () => {
    const { hashPassword } = await import('../src/utils/password');
    await client.query('UPDATE users SET password_hash = $1 WHERE id = 1', [await hashPassword('vieja-clave-1')]);

    // Same answer whether the user exists or not
    const unknown = await call('/api/auth/forgot', json({ login: 'nadie@test.dev' }));
    expect(unknown.status).toBe(200);
    expect(sentMails).toEqual([]);
    const known = await call('/api/auth/forgot', json({ login: 'ANA@test.dev' }));
    expect(await known.json()).toEqual(await unknown.json());
    expect(sentMails).toEqual([expect.objectContaining({ to: 'ana@test.dev', subject: expect.stringContaining('contraseña') })]);

    // The emailed token is never stored as is: grab it by issuing a known one
    const { rows } = await client.query<{ token_hash: string }>('SELECT token_hash FROM password_resets');
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);

    const token = 'a'.repeat(64);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    await client.query("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (1, $1, now() + interval '1 hour')", [hash]);

    expect((await call('/api/auth/reset', json({ token, password: 'corta' }))).status).toBe(400);
    expect((await call('/api/auth/reset', json({ token, password: 'nueva-clave-1' }))).status).toBe(200);
    expect((await call('/api/auth/reset', json({ token, password: 'otra-clave-22' }))).status).toBe(400); // used

    // The old session (tv 0) ended; the new password works
    expect((await call('/api/orders', {}, true)).status).toBe(401);
    const login = await call('/api/auth/login', json({ username: 'ana', password: 'nueva-clave-1' }));
    expect(login.status).toBe(200);
  });

  it('rejects expired links', async () => {
    const token = 'b'.repeat(64);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    await client.query("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (1, $1, now() - interval '1 minute')", [hash]);
    expect((await call('/api/auth/reset', json({ token, password: 'nueva-clave-1' }))).status).toBe(400);
  });
});

describe('manual orders, edits and notes', () => {
  const manual = { name: 'Rosa', phone: '(413) 555-0001', paymentMethod: 'cash', items: [{ productId: 1, quantity: 1 }] };

  it('creates an order from the panel with only name and phone', async () => {
    expect((await call('/api/orders/manual', json(manual))).status).toBe(401);
    const res = await call('/api/orders/manual', json(manual), true);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ source: 'manual', total: 120.5, status: 'pending', customerEmail: '' });
    expect(sentMails).toEqual([]); // no email given
    expect((await call('/api/orders/manual', json({ ...manual, email: 'rosa@test.dev' }), true)).status).toBe(201);
    expect(sentMails.map((m) => m.to)).toEqual(['rosa@test.dev']);
    expect((await call('/api/orders/manual', json({ ...manual, items: [{ productId: 2, quantity: 9 }] }), true)).status).toBe(409);
  });

  it('edits products and customer data while the order has not taken stock', async () => {
    await call('/api/orders/manual', json(manual), true);
    const edit = (body: Record<string, unknown>) =>
      call('/api/orders/1', { method: 'PUT', body: JSON.stringify({ ...manual, ...body }) }, true);
    const res = await edit({ name: 'Rosa M.', items: [{ productId: 1, quantity: 2 }, { productId: 2, quantity: 1 }] });
    expect(await res.json()).toMatchObject({ customerName: 'Rosa M.', total: 321 });

    await call('/api/orders/1/status', { method: 'PATCH', body: JSON.stringify({ status: 'paid' }) }, true);
    expect((await edit({})).status).toBe(409);
  });

  it('keeps internal notes', async () => {
    await call('/api/orders/manual', json(manual), true);
    const res = await call('/api/orders/1/notes', { method: 'PATCH', body: JSON.stringify({ adminNotes: 'Envolver para regalo' }) }, true);
    expect(await res.json()).toMatchObject({ adminNotes: 'Envolver para regalo' });
    // Not in the customer's view
    const tracked = await (await call('/api/orders/track?id=1&phone=4135550001')).json();
    expect(JSON.stringify(tracked)).not.toContain('regalo');
  });
});

describe('customers', () => {
  it('groups orders by phone and adds up what each customer bought', async () => {
    const order = (phone: string, productId: number) =>
      call('/api/orders', json({ ...customer, phone, items: [{ productId, quantity: 1 }] }));
    await order('413-555-0001', 1);
    await order('+1 (413) 555-0001', 2);
    await order('413-555-0002', 2);
    await call('/api/orders/1/status', { method: 'PATCH', body: JSON.stringify({ status: 'paid' }) }, true);

    expect((await call('/api/orders/customers')).status).toBe(401);
    const list = (await (await call('/api/orders/customers', {}, true)).json()) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);
    const rosa = list.find((c) => c.key === '4135550001');
    expect(rosa).toMatchObject({ orders: 2, openOrders: 1, spent: 120.5, orderIds: [2, 1] });
  });
});

describe('cost at sale time', () => {
  it('keeps the cost the product had when it was sold', async () => {
    await client.exec('UPDATE products SET cost = 50 WHERE id = 1');
    await call('/api/sales', json({ productId: 1, quantity: 1 }), true);
    await client.exec('UPDATE products SET cost = 70 WHERE id = 1');
    const [sale] = (await (await call('/api/sales', {}, true)).json()) as Array<{ unitCost: number }>;
    expect(sale.unitCost).toBe(50);
  });
});

describe('deleting a product', () => {
  it('also deletes its image files', async () => {
    await client.exec("INSERT INTO products (code, name, name_en, slug, category_id, subcategory_id, price, stock) VALUES ('N1', 'Nuevo', 'New', 'nuevo', 1, 1, 10, 0)");
    await client.exec("INSERT INTO product_images (product_id, filename, data) VALUES (4, 'a.jpg', 'https://cdn.test/products/4/a.jpg')");
    bucket.objects.set('products/4/a.jpg', { bytes: new ArrayBuffer(1) });
    expect((await call('/api/products/4', { method: 'DELETE' }, true)).status).toBe(200);
    expect(bucket.objects.has('products/4/a.jpg')).toBe(false);
  });
});
