import { Hono } from 'hono';
import { desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db';
import { ordersTable, productsTable } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { parseFields, parseId, toMoney } from '../utils/validate';

type Bindings = { DATABASE_URL: string; JWT_SECRET: string; IMAGES: R2Bucket };

const PAYMENT_METHODS = ['transfer', 'googlepay', 'paypal', 'whatsapp'];
const ORDER_STATUSES = ['pending', 'confirmed', 'paid', 'shipped', 'delivered', 'cancelled'];

const MAX_ITEMS = 50;
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
const RECEIPT_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

const orderSpec = {
  name: { type: 'string', min: 1, max: 120 },
  phone: { type: 'string', min: 1, max: 40 },
  address: { type: 'string', min: 1, max: 300 },
  city: { type: 'string', min: 1, max: 120 },
  notes: { type: 'string', max: 1000 },
  paymentMethod: { type: 'string', min: 1, max: 20 },
} as const;

const itemSpec = {
  productId: { type: 'number', integer: true, min: 1 },
  quantity: { type: 'number', integer: true, min: 1, max: 99 },
} as const;

// Transfer receipts live under this prefix in R2 and are only served through
// the authenticated endpoint below.
const receiptPrefix = (orderId: number) => `receipts/${orderId}/`;

const orders = new Hono<{ Bindings: Bindings }>();

// Admin: list all orders, newest first
orders.get('/', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db
    .select()
    .from(ordersTable)
    .orderBy(desc(ordersTable.createdAt));
  return c.json(rows);
});

// Public: create order (called at checkout).
// Accepts JSON, or multipart/form-data with a `data` field (the same JSON)
// plus an optional `receipt` file for bank transfers.
// Prices and the total are always taken from the database, never the client.
orders.post('/', rateLimit('PUBLIC_LIMITER'), async (c) => {
  let payload: unknown;
  let receipt: File | null = null;
  if ((c.req.header('Content-Type') ?? '').includes('multipart/form-data')) {
    const form = await c.req.parseBody();
    if (typeof form.data !== 'string') return c.json({ error: 'data is required' }, 400);
    payload = JSON.parse(form.data);
    if (form.receipt instanceof File && form.receipt.size > 0) receipt = form.receipt;
  } else {
    payload = await c.req.json<unknown>();
  }

  const parsed = parseFields(payload, orderSpec, ['name', 'phone', 'address', 'city', 'paymentMethod']);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const order = parsed.data;
  if (!PAYMENT_METHODS.includes(order.paymentMethod)) return c.json({ error: 'Invalid payment method' }, 400);

  const rawItems = (payload as { items?: unknown }).items;
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > MAX_ITEMS) {
    return c.json({ error: 'El pedido no tiene productos.' }, 400);
  }
  const quantities = new Map<number, number>();
  for (const raw of rawItems) {
    const item = parseFields(raw, itemSpec, ['productId', 'quantity']);
    if (!item.ok) return c.json({ error: item.error }, 400);
    const { productId, quantity } = item.data;
    quantities.set(productId, (quantities.get(productId) ?? 0) + quantity);
  }

  if (receipt) {
    if (!RECEIPT_TYPES[receipt.type]) return c.json({ error: 'El comprobante debe ser una imagen (JPG, PNG, WebP) o un PDF.' }, 400);
    if (receipt.size > MAX_RECEIPT_BYTES) return c.json({ error: 'El comprobante no puede superar los 5 MB.' }, 400);
  }

  const db = getDb(c.env.DATABASE_URL);
  const products = await db
    .select({
      id: productsTable.id,
      code: productsTable.code,
      name: productsTable.name,
      price: productsTable.price,
      active: productsTable.active,
    })
    .from(productsTable)
    .where(inArray(productsTable.id, [...quantities.keys()]));

  const items = [];
  for (const [productId, quantity] of quantities) {
    const product = products.find((p) => p.id === productId);
    if (!product || !product.active) {
      return c.json({ error: 'Uno de los productos de tu carrito ya no está disponible.' }, 409);
    }
    items.push({
      productId,
      code: product.code,
      name: product.name,
      price: product.price,
      quantity,
      subtotal: toMoney(product.price * quantity),
    });
  }
  const total = toMoney(items.reduce((sum, item) => sum + item.subtotal, 0));

  const [row] = await db
    .insert(ordersTable)
    .values({
      customerName: order.name,
      customerPhone: order.phone,
      customerAddress: order.address,
      customerCity: order.city,
      notes: order.notes ?? '',
      paymentMethod: order.paymentMethod,
      items,
      total,
    })
    .returning();

  // The order is already saved; a failed upload shouldn't lose it.
  let receiptUploaded = false;
  if (receipt && order.paymentMethod === 'transfer') {
    try {
      const key = `${receiptPrefix(row.id)}${crypto.randomUUID()}.${RECEIPT_TYPES[receipt.type]}`;
      await c.env.IMAGES.put(key, await receipt.arrayBuffer(), { httpMetadata: { contentType: receipt.type } });
      receiptUploaded = true;
    } catch (err) {
      console.error('Receipt upload failed for order', row.id, err);
    }
  }

  return c.json({ id: row.id, total: row.total, receiptUploaded }, 201);
});

// Admin: download the transfer receipt attached to an order
orders.get('/:id/receipt', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Not found' }, 404);
  const listed = await c.env.IMAGES.list({ prefix: receiptPrefix(id), limit: 1 });
  const key = listed.objects[0]?.key;
  const object = key ? await c.env.IMAGES.get(key) : null;
  if (!object) return c.json({ error: 'Este pedido no tiene comprobante.' }, 404);
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      'Cache-Control': 'private, no-store',
    },
  });
});

// Admin: update order status
orders.patch('/:id/status', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Not found' }, 404);
  const { status } = await c.req.json<{ status?: unknown }>();
  if (typeof status !== 'string' || !ORDER_STATUSES.includes(status)) {
    return c.json({ error: 'Invalid status' }, 400);
  }
  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db
    .update(ordersTable)
    .set({ status })
    .where(eq(ordersTable.id, id))
    .returning();
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

export { orders };
