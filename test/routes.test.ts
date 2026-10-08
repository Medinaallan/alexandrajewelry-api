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

const { default: app } = await import('../src/index');

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
    async delete(key: string) {
      objects.delete(key);
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

const customer = { name: 'Ana', phone: '555', address: 'Calle 1', city: 'Caracas', notes: '', paymentMethod: 'transfer' };

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
  await client.exec(`
    TRUNCATE orders, sales, stock_products, product_images, products, subcategories, categories, users RESTART IDENTITY CASCADE;
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
  });

  it('only updates fields that are allowed', async () => {
    const res = await call('/api/products/1', {
      method: 'PUT',
      body: JSON.stringify({ price: 150, id: 77, createdAt: '2000-01-01', nameEn: 'Ring' }),
    }, true);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 1, price: 150, name: 'Anillo', nameEn: 'Ring', stock: 5 });
  });

  it('keeps a translation the admin corrected by hand', async () => {
    const res = await call('/api/products/1', { method: 'PUT', body: JSON.stringify({ nameEn: 'Gold band' }) }, true);
    expect(await res.json()).toMatchObject({ name: 'Anillo', nameEn: 'Gold band' });
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

describe('users', () => {
  it('does not let the last admin delete or deactivate themselves', async () => {
    expect((await call('/api/users/1', { method: 'DELETE' }, true)).status).toBe(409);
    expect((await call('/api/users/1/toggle', { method: 'PATCH' }, true)).status).toBe(409);
    const list = (await (await call('/api/users', {}, true)).json()) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('passwordHash');
  });

  it('blocks tokens without the admin role', async () => {
    const staff = await new SignJWT({ sub: '2', role: 'staff', username: 'bob' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(JWT_SECRET));
    const res = await app.request('/api/users', { headers: { Authorization: `Bearer ${staff}` } }, env());
    expect(res.status).toBe(403);
  });
});
