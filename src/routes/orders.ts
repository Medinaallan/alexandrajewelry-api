import { Hono } from 'hono';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { getDb, type Db } from '../db';
import { ordersTable, productsTable } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import {
  registerSales,
  releaseOrderStock,
  setOrderStatus,
  InsufficientStockError,
  OrderChangedError,
} from '../db/inventory';
import { rateLimit } from '../middleware/rateLimit';
import { parseFields, parseId, toMoney } from '../utils/validate';
import {
  executionCtx,
  inBackground,
  isEmail,
  newOrderStoreMail,
  orderReceivedMail,
  paypalStoreMail,
  sendMail,
  statusMail,
  type MailEnv,
  type OrderForMail,
} from '../mail';

type Bindings = { DATABASE_URL: string; JWT_SECRET: string; IMAGES: R2Bucket } & MailEnv;
type Variables = { username: string };

const PAYMENT_METHODS = ['transfer', 'googlepay', 'paypal', 'whatsapp'];
// `review`: the customer reported a PayPal payment the admin has not checked yet.
const ORDER_STATUSES = ['pending', 'confirmed', 'review', 'paid', 'shipped', 'delivered', 'cancelled'];
// In these statuses the order's units are out of stock and counted as sales.
// Entering one sells the items; leaving to any other status undoes that.
const STOCK_TAKEN = new Set(['review', 'paid', 'shipped', 'delivered']);

/** An unpaid PayPal order is cancelled this long after it was placed. */
export const PAYPAL_HOLD_MS = 24 * 60 * 60 * 1000;

type OrderItem = { productId: number; name: string; price: number; quantity: number };

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
  email: { type: 'string', min: 1, max: 200 },
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

type OrderRow = typeof ordersTable.$inferSelect;

function toMailOrder(row: OrderRow): OrderForMail {
  const items = (Array.isArray(row.items) ? row.items : []) as Array<OrderItem & { subtotal?: number }>;
  return {
    id: row.id,
    customerName: row.customerName,
    customerEmail: row.customerEmail,
    customerPhone: row.customerPhone,
    customerAddress: row.customerAddress,
    customerCity: row.customerCity,
    notes: row.notes,
    paymentMethod: row.paymentMethod,
    total: row.total,
    items: items.map((i) => ({ name: i.name, quantity: i.quantity, subtotal: i.subtotal ?? toMoney(i.price * i.quantity) })),
  };
}

/** A PayPal order still waiting for its payment, within its 24 hours. */
function canPayWithPaypal(row: OrderRow, now = Date.now()): boolean {
  return (
    row.paymentMethod === 'paypal' &&
    (row.status === 'pending' || row.status === 'confirmed') &&
    row.paymentRef == null &&
    now - new Date(row.createdAt).getTime() < PAYPAL_HOLD_MS
  );
}

/**
 * Cancels PayPal orders nobody paid within 24 hours and tells each customer.
 * Run by the hourly cron. No stock to return: unpaid orders never took any.
 */
export async function expireUnpaidPaypalOrders(db: Db, env: MailEnv): Promise<number> {
  const cutoff = new Date(Date.now() - PAYPAL_HOLD_MS);
  const expired = await db
    .update(ordersTable)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(ordersTable.paymentMethod, 'paypal'),
        inArray(ordersTable.status, ['pending', 'confirmed']),
        isNull(ordersTable.paymentRef),
        lt(ordersTable.createdAt, cutoff),
      ),
    )
    .returning();
  await Promise.all(
    expired.map((row) => {
      const mail = statusMail(env, toMailOrder(row), 'cancelled', 'No recibimos el pago dentro de las 24 horas.');
      return mail ? sendMail(env, mail) : false;
    }),
  );
  return expired.length;
}

const orders = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Admin: list all orders, newest first
orders.get('/', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db
    .select()
    .from(ordersTable)
    .orderBy(desc(ordersTable.createdAt));
  return c.json(rows);
});

// Admin: how many orders are waiting (polled by the panel to announce new ones)
orders.get('/pending-count', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db
    .select({ count: sql<number>`cast(count(*) as int)`, lastId: sql<number | null>`max(${ordersTable.id})` })
    .from(ordersTable)
    .where(eq(ordersTable.status, 'pending'));
  return c.json({ count: row?.count ?? 0, lastId: row?.lastId ?? null });
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

  const parsed = parseFields(payload, orderSpec, ['name', 'phone', 'email', 'address', 'city', 'paymentMethod']);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const order = parsed.data;
  if (!PAYMENT_METHODS.includes(order.paymentMethod)) return c.json({ error: 'Invalid payment method' }, 400);
  if (!isEmail(order.email)) return c.json({ error: 'Escribe un correo electrónico válido.' }, 400);

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
      stock: productsTable.stock,
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
    // Stock is only checked here; it is taken when the order is marked paid.
    if (product.stock < quantity) {
      return c.json({
        error: product.stock === 0
          ? `"${product.name}" está agotado. Quítalo del carrito para continuar.`
          : `Solo quedan ${product.stock} unidades de "${product.name}". Ajusta la cantidad para continuar.`,
      }, 409);
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
      customerEmail: order.email,
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

  const mailOrder = toMailOrder(row);
  await inBackground(
    executionCtx(c),
    Promise.all([sendMail(c.env, orderReceivedMail(c.env, mailOrder)), sendMail(c.env, newOrderStoreMail(c.env, mailOrder))]),
  );

  return c.json({ id: row.id, total: row.total, receiptUploaded }, 201);
});

/** "+58 (412) 555-1234" → "584125551234" */
const phoneDigits = (phone: string) => phone.replace(/\D/g, '');

// Public: a customer checks their order with its number and their phone.
// A wrong phone answers exactly like a missing order, so order numbers
// can't be probed; the rate limit slows down guessing.
orders.get('/track', rateLimit('PUBLIC_LIMITER'), async (c) => {
  const id = parseId(c.req.query('id') ?? '');
  const phone = phoneDigits(c.req.query('phone') ?? '');
  const notFound = () => c.json({ error: 'No encontramos un pedido con ese número y teléfono.' }, 404);
  if (!id || phone.length < 6) return notFound();
  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db.select().from(ordersTable).where(eq(ordersTable.id, id));
  if (!row || phoneDigits(row.customerPhone) !== phone) return notFound();
  const items = (Array.isArray(row.items) ? row.items : []) as Array<OrderItem & { subtotal: number }>;
  return c.json({
    id: row.id,
    status: row.status,
    paymentMethod: row.paymentMethod,
    total: row.total,
    createdAt: row.createdAt,
    paymentReported: row.paymentRef != null,
    canPay: canPayWithPaypal(row),
    items: items.map((i) => ({ name: i.name, quantity: i.quantity, subtotal: i.subtotal })),
  });
});

// PayPal ids are uppercase letters and digits (capture ids are 17 long).
const PAYPAL_ID = /^[A-Z0-9]{10,40}$/;

const notFoundMsg = 'No encontramos un pedido con ese número y teléfono.';

/** The order, if the phone matches (the phone works as in /track). */
async function orderForCustomer(db: Db, id: number | null, phone: string): Promise<OrderRow | null> {
  if (!id) return null;
  const [row] = await db.select().from(ordersTable).where(eq(ordersTable.id, id));
  return row && phoneDigits(row.customerPhone) === phoneDigits(phone) ? row : null;
}

/** First product of the order without enough stock, if any. */
async function shortItem(db: Db, row: OrderRow) {
  const items = (Array.isArray(row.items) ? row.items : []) as OrderItem[];
  const stock = await db
    .select({ id: productsTable.id, stock: productsTable.stock })
    .from(productsTable)
    .where(inArray(productsTable.id, items.map((i) => i.productId)));
  const short = items.find((i) => (stock.find((p) => p.id === i.productId)?.stock ?? 0) < i.quantity);
  return short ? { ...short, available: stock.find((p) => p.id === short.productId)?.stock ?? 0 } : null;
}

// Public: called right before opening PayPal, so nobody pays for an order
// that expired or whose products sold out meanwhile. Answers the amount to charge.
orders.post('/:id/paypal/check', rateLimit('PUBLIC_LIMITER'), async (c) => {
  const body = await c.req.json<{ phone?: unknown }>().catch(() => ({}) as { phone?: unknown });
  const db = getDb(c.env.DATABASE_URL);
  const row = await orderForCustomer(db, parseId(c.req.param('id')), typeof body.phone === 'string' ? body.phone : '');
  if (!row) return c.json({ error: notFoundMsg }, 404);
  if (!canPayWithPaypal(row)) {
    return c.json({ error: 'Este pedido ya no se puede pagar (venció, ya tiene un pago o fue cancelado).' }, 409);
  }
  const short = await shortItem(db, row);
  if (short) {
    return c.json({ error: `Lo sentimos: "${short.name}" se agotó. Escríbenos y te ayudamos con tu pedido.` }, 409);
  }
  return c.json({ total: row.total });
});

// Public: the customer's browser reports a PayPal payment for the order.
// The API has no PayPal secret, so this is NOT a proof of payment: the admin
// checks it in PayPal. To keep two customers from paying for the same last
// unit, the stock is taken right away (status `review`); if it ran out, the
// payment is still noted and the admin is warned to restock or refund.
// Only the first report is kept.
orders.post('/:id/paypal', rateLimit('PUBLIC_LIMITER'), async (c) => {
  const body = await c.req.json<unknown>().catch(() => null);
  const parsed = parseFields(body, {
    phone: { type: 'string', min: 1, max: 40 },
    captureId: { type: 'string', min: 1, max: 40 },
    amount: { type: 'number', min: 0 },
  } as const, ['phone', 'captureId', 'amount']);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { phone, captureId, amount } = parsed.data;
  if (!PAYPAL_ID.test(captureId)) return c.json({ error: 'Invalid capture id' }, 400);

  const db = getDb(c.env.DATABASE_URL);
  const row = await orderForCustomer(db, parseId(c.req.param('id')), phone);
  if (!row) return c.json({ error: notFoundMsg }, 404);
  // A late payment (after 24 h but before the cron cancelled it) is still kept.
  if (row.paymentMethod !== 'paypal' || !['pending', 'confirmed'].includes(row.status)) {
    return c.json({ error: 'Este pedido no espera un pago con PayPal.' }, 409);
  }

  const noted = await db
    .update(ordersTable)
    .set({ paymentRef: captureId, paymentAmount: toMoney(amount) })
    .where(and(eq(ordersTable.id, row.id), isNull(ordersTable.paymentRef)))
    .returning({ id: ordersTable.id });
  if (noted.length === 0) return c.json({ error: 'Este pedido ya tiene un pago registrado.' }, 409);

  let stockShort = false;
  try {
    const items = (Array.isArray(row.items) ? row.items : []) as OrderItem[];
    await registerSales(
      db,
      items.map((i) => ({ productId: i.productId, quantity: i.quantity, unitPrice: i.price, notes: `Pedido #${row.id} (PayPal)` })),
      'PayPal',
      { id: row.id, from: row.status, to: 'review' },
    );
  } catch (err) {
    if (err instanceof InsufficientStockError) stockShort = true;
    else if (!(err instanceof OrderChangedError)) throw err;
  }

  const mailOrder = toMailOrder(row);
  const customerMail = stockShort
    ? null
    : statusMail(c.env, mailOrder, 'review');
  await inBackground(
    executionCtx(c),
    Promise.all([
      sendMail(c.env, paypalStoreMail(c.env, mailOrder, captureId, amount, stockShort)),
      customerMail ? sendMail(c.env, customerMail) : false,
    ]),
  );
  return c.json({ ok: true, stockShort });
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

// Admin: update order status. Moving into paid/shipped/delivered sells the
// items (stock out, rows in sales); moving back out returns them.
orders.patch('/:id/status', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Not found' }, 404);
  const { status } = await c.req.json<{ status?: unknown }>();
  if (typeof status !== 'string' || !ORDER_STATUSES.includes(status)) {
    return c.json({ error: 'Invalid status' }, 400);
  }
  const db = getDb(c.env.DATABASE_URL);
  const [current] = await db.select().from(ordersTable).where(eq(ordersTable.id, id));
  if (!current) return c.json({ error: 'Not found' }, 404);
  if (current.status === status) return c.json(current);

  const transition = { id, from: current.status, to: status };
  const takes = !STOCK_TAKEN.has(current.status) && STOCK_TAKEN.has(status);
  const releases = STOCK_TAKEN.has(current.status) && !STOCK_TAKEN.has(status);

  try {
    if (takes) {
      const items = (Array.isArray(current.items) ? current.items : []) as OrderItem[];
      // Friendly message naming the product; registerSales re-checks atomically.
      const short = await shortItem(db, current);
      if (short) {
        return c.json({
          error: `No hay stock suficiente de "${short.name}" (pide ${short.quantity}, hay ${short.available}). Agrega stock antes de marcar el pedido.`,
        }, 409);
      }
      await registerSales(
        db,
        items.map((i) => ({ productId: i.productId, quantity: i.quantity, unitPrice: i.price, notes: `Pedido #${id}` })),
        c.get('username') ?? '',
        transition,
      );
    } else if (releases) {
      await releaseOrderStock(db, transition);
    } else {
      await setOrderStatus(db, transition);
    }
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      return c.json({ error: 'El stock cambió mientras actualizabas el pedido. Intenta de nuevo.' }, 409);
    }
    if (err instanceof OrderChangedError) {
      return c.json({ error: 'Otra persona cambió este pedido. Recarga la página.' }, 409);
    }
    throw err;
  }

  const [row] = await db.select().from(ordersTable).where(eq(ordersTable.id, id));
  // Tell the customer, except when going back to "pending"
  const mail = statusMail(c.env, toMailOrder(row), status);
  if (mail) await inBackground(executionCtx(c), sendMail(c.env, mail));
  return c.json(row);
});

export { orders };
