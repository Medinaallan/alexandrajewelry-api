import { Hono } from 'hono';
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { getDb, type Db } from '../db';
import { contactMessagesTable, ordersTable, productsTable, salesTable, testimonialsTable } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import {
  registerSales,
  releaseOrderStock,
  setOrderStatus,
  InsufficientStockError,
  OrderChangedError,
} from '../db/inventory';
import { rateLimit } from '../middleware/rateLimit';
import { readPaypalSettings } from './settings';
import { parseFields, parseId, toMoney } from '../utils/validate';
import {
  executionCtx,
  inBackground,
  isEmail,
  newOrderStoreMail,
  orderReceivedMail,
  paypalStoreMail,
  receiptStoreMail,
  sendMail,
  statusMail,
  withStore,
  type MailEnv,
  type OrderForMail,
} from '../mail';

type Bindings = { DATABASE_URL: string; JWT_SECRET: string; IMAGES: R2Bucket } & MailEnv;
type Variables = { username: string };

const PAYMENT_METHODS = ['transfer', 'googlepay', 'paypal', 'whatsapp'];
// Orders entered in the panel can also be paid in cash at the store
const MANUAL_PAYMENT_METHODS = ['transfer', 'paypal', 'whatsapp', 'cash'];
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
  const expired = await db
    .update(ordersTable)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(ordersTable.paymentMethod, 'paypal'),
        // Orders typed in the panel are followed up by the operator, never expired
        eq(ordersTable.source, 'web'),
        inArray(ordersTable.status, ['pending', 'confirmed']),
        isNull(ordersTable.paymentRef),
        // Compared in the database's own clock (created_at is set by it)
        lt(ordersTable.createdAt, sql`now() - make_interval(secs => ${PAYPAL_HOLD_MS / 1000})`),
      ),
    )
    .returning();
  const menv = await withStore(env);
  await Promise.all(
    expired.map((row) => {
      const mail = statusMail(menv, toMailOrder(row), 'cancelled', 'No recibimos el pago dentro de las 24 horas.');
      return mail ? sendMail(menv, mail) : false;
    }),
  );
  return expired.length;
}

type PricedItem = { productId: number; code: string; name: string; price: number; quantity: number; subtotal: number };
type Priced = { ok: true; items: PricedItem[]; total: number } | { ok: false; status: 400 | 409; error: string };

/**
 * Turns [{productId, quantity}] into order lines with the current prices from
 * the database (never the client's). Products must be on sale and in stock;
 * stock is only checked here, it is taken when the order is marked paid.
 */
async function priceItems(db: Db, rawItems: unknown): Promise<Priced> {
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > MAX_ITEMS) {
    return { ok: false, status: 400, error: 'El pedido no tiene productos.' };
  }
  const quantities = new Map<number, number>();
  for (const raw of rawItems) {
    const item = parseFields(raw, itemSpec, ['productId', 'quantity']);
    if (!item.ok) return { ok: false, status: 400, error: item.error };
    const { productId, quantity } = item.data;
    quantities.set(productId, (quantities.get(productId) ?? 0) + quantity);
  }
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

  const items: PricedItem[] = [];
  for (const [productId, quantity] of quantities) {
    const product = products.find((p) => p.id === productId);
    if (!product || !product.active) {
      return { ok: false, status: 409, error: 'Uno de los productos de tu carrito ya no está disponible.' };
    }
    if (product.stock < quantity) {
      return {
        ok: false,
        status: 409,
        error: product.stock === 0
          ? `"${product.name}" está agotado. Quítalo del carrito para continuar.`
          : `Solo quedan ${product.stock} unidades de "${product.name}". Ajusta la cantidad para continuar.`,
      };
    }
    items.push({ productId, code: product.code, name: product.name, price: product.price, quantity, subtotal: toMoney(product.price * quantity) });
  }
  return { ok: true, items, total: toMoney(items.reduce((sum, item) => sum + item.subtotal, 0)) };
}

// Customer data an admin types in (manual orders and edits): only name and phone are required
const adminOrderSpec = {
  name: { type: 'string', min: 1, max: 120 },
  phone: { type: 'string', min: 1, max: 40 },
  email: { type: 'string', max: 200 },
  address: { type: 'string', max: 300 },
  city: { type: 'string', max: 120 },
  notes: { type: 'string', max: 1000 },
  paymentMethod: { type: 'string', min: 1, max: 20 },
} as const;

/** Validates the customer part of an admin order; returns the DB fields or an error. */
function parseAdminCustomer(payload: unknown) {
  const parsed = parseFields(payload, adminOrderSpec, ['name', 'phone', 'paymentMethod']);
  if (!parsed.ok) return { ok: false as const, error: parsed.error };
  const d = parsed.data;
  if (!MANUAL_PAYMENT_METHODS.includes(d.paymentMethod)) return { ok: false as const, error: 'Forma de pago no válida.' };
  const email = (d.email ?? '').trim();
  if (email && !isEmail(email)) return { ok: false as const, error: 'El correo del cliente no es válido.' };
  return {
    ok: true as const,
    fields: {
      customerName: d.name.trim(),
      customerPhone: d.phone.trim(),
      customerEmail: email,
      customerAddress: (d.address ?? '').trim(),
      customerCity: (d.city ?? '').trim(),
      notes: d.notes ?? '',
      paymentMethod: d.paymentMethod,
    },
  };
}

/** The store's time zone: "today" on the summary page means its day. */
const STORE_TIMEZONE = 'America/New_York';

/** Waiting for the operator to collect the payment (not a PayPal order waiting for the customer). */
// (Orders typed in the panel are always collected by the operator, PayPal included.)
const NEEDS_PAYMENT = sql`${ordersTable.status} in ('pending', 'confirmed') and not (${ordersTable.paymentMethod} = 'paypal' and ${ordersTable.paymentRef} is null and ${ordersTable.source} = 'web')`;

/**
 * Saves a transfer receipt for the order and, if the order is still waiting,
 * sets its stock aside by moving it to "review" (payment to check). If the
 * stock ran out, the receipt is kept and the order stays as it was.
 */
async function attachReceipt(env: Bindings, db: Db, row: OrderRow, file: File): Promise<{ saved: boolean; stockShort: boolean }> {
  try {
    const key = `${receiptPrefix(row.id)}${Date.now()}-${crypto.randomUUID()}.${RECEIPT_TYPES[file.type]}`;
    await env.IMAGES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
  } catch (err) {
    console.error('Receipt upload failed for order', row.id, err);
    return { saved: false, stockShort: false };
  }
  await db.update(ordersTable).set({ receiptAt: sql`now()` }).where(eq(ordersTable.id, row.id));
  if (!['pending', 'confirmed'].includes(row.status)) return { saved: true, stockShort: false };
  try {
    const items = (Array.isArray(row.items) ? row.items : []) as OrderItem[];
    await registerSales(
      db,
      items.map((i) => ({ productId: i.productId, quantity: i.quantity, unitPrice: i.price, notes: `Pedido #${row.id} (transferencia)` })),
      'Transferencia',
      { id: row.id, from: row.status, to: 'review' },
    );
    return { saved: true, stockShort: false };
  } catch (err) {
    if (err instanceof InsufficientStockError) return { saved: true, stockShort: true };
    if (err instanceof OrderChangedError) return { saved: true, stockShort: false };
    throw err;
  }
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
    .select({
      toAttend: sql<number>`cast(count(*) filter (where ${NEEDS_PAYMENT}) as int)`,
      toVerify: sql<number>`cast(count(*) filter (where ${ordersTable.status} = 'review') as int)`,
      toShip: sql<number>`cast(count(*) filter (where ${ordersTable.status} = 'paid') as int)`,
      // Newest order placed on the website (orders typed in the panel aren't announced)
      lastId: sql<number | null>`max(${ordersTable.id}) filter (where ${ordersTable.source} = 'web')`,
    })
    .from(ordersTable);
  const toAttend = row?.toAttend ?? 0;
  const toVerify = row?.toVerify ?? 0;
  const toShip = row?.toShip ?? 0;
  return c.json({ count: toAttend + toVerify + toShip, toAttend, toVerify, toShip, lastId: row?.lastId ?? null });
});

// Admin: everything the summary page shows, in one call
orders.get('/dashboard', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  // "Today" is the store's day (Massachusetts), not UTC
  const today = sql`(now() AT TIME ZONE ${STORE_TIMEZONE})::date`;
  const localDate = (col: unknown) => sql`((${col}) AT TIME ZONE 'UTC' AT TIME ZONE ${STORE_TIMEZONE})::date`;
  const [[counts], [messages], [reviews], lowStock, [salesToday]] = await Promise.all([
    db
      .select({
        toAttend: sql<number>`cast(count(*) filter (where ${NEEDS_PAYMENT}) as int)`,
        toVerify: sql<number>`cast(count(*) filter (where ${ordersTable.status} = 'review') as int)`,
        stockShort: sql<number>`cast(count(*) filter (where ${ordersTable.status} in ('pending', 'confirmed') and ${ordersTable.paymentRef} is not null) as int)`,
        toShip: sql<number>`cast(count(*) filter (where ${ordersTable.status} = 'paid') as int)`,
        paypalWaiting: sql<number>`cast(count(*) filter (where ${ordersTable.status} in ('pending', 'confirmed') and ${ordersTable.paymentMethod} = 'paypal' and ${ordersTable.paymentRef} is null and ${ordersTable.source} = 'web') as int)`,
        ordersToday: sql<number>`cast(count(*) filter (where ${localDate(ordersTable.createdAt)} = ${today}) as int)`,
      })
      .from(ordersTable),
    db.select({ n: sql<number>`cast(count(*) as int)` }).from(contactMessagesTable).where(eq(contactMessagesTable.read, false)),
    db.select({ n: sql<number>`cast(count(*) as int)` }).from(testimonialsTable).where(eq(testimonialsTable.status, 'pending')),
    db
      .select({ id: productsTable.id, code: productsTable.code, name: productsTable.name, stock: productsTable.stock, minStock: productsTable.minStock })
      .from(productsTable)
      .where(and(eq(productsTable.active, true), or(eq(productsTable.stock, 0), sql`${productsTable.stock} <= ${productsTable.minStock}`)))
      .orderBy(productsTable.stock, productsTable.name),
    db
      .select({
        count: sql<number>`cast(count(*) as int)`,
        units: sql<number>`cast(coalesce(sum(${salesTable.quantity}), 0) as int)`,
        total: sql<number>`cast(coalesce(sum(${salesTable.total}), 0) as float8)`,
      })
      .from(salesTable)
      .where(sql`${localDate(salesTable.createdAt)} = ${today}`),
  ]);
  return c.json({
    ...counts,
    unreadMessages: messages?.n ?? 0,
    pendingReviews: reviews?.n ?? 0,
    lowStock,
    salesToday: { count: salesToday?.count ?? 0, units: salesToday?.units ?? 0, total: toMoney(salesToday?.total ?? 0) },
  });
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
  if (order.paymentMethod === 'paypal') {
    const paypal = await readPaypalSettings(c.env.DATABASE_URL);
    if (paypal && !paypal.enabled) return c.json({ error: 'El pago con PayPal no está disponible. Elige otra forma de pago.' }, 400);
  }

  if (receipt) {
    if (!RECEIPT_TYPES[receipt.type]) return c.json({ error: 'El comprobante debe ser una imagen (JPG, PNG, WebP) o un PDF.' }, 400);
    if (receipt.size > MAX_RECEIPT_BYTES) return c.json({ error: 'El comprobante no puede superar los 5 MB.' }, 400);
  }

  const db = getDb(c.env.DATABASE_URL);
  const priced = await priceItems(db, (payload as { items?: unknown }).items);
  if (!priced.ok) return c.json({ error: priced.error }, priced.status);
  const { items, total } = priced;

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
    receiptUploaded = (await attachReceipt(c.env, db, row, receipt)).saved;
  }

  const menv = await withStore(c.env);
  const mailOrder = toMailOrder(row);
  await inBackground(
    executionCtx(c),
    Promise.all([
      sendMail(menv, orderReceivedMail(menv, mailOrder, receiptUploaded)),
      sendMail(menv, newOrderStoreMail(menv, mailOrder, receiptUploaded)),
    ]),
  );

  return c.json({ id: row.id, total: row.total, receiptUploaded }, 201);
});

/** "+58 (412) 555-1234" → "584125551234" */
const phoneDigits = (phone: string) => phone.replace(/\D/g, '');

// Admin: an order taken outside the website (WhatsApp, Instagram, the store).
// Same prices and stock check as the checkout. The customer gets the usual
// email if one is given; the store isn't notified (it typed it in).
orders.post('/manual', requireAuth, async (c) => {
  const payload = await c.req.json<unknown>();
  const customer = parseAdminCustomer(payload);
  if (!customer.ok) return c.json({ error: customer.error }, 400);
  const db = getDb(c.env.DATABASE_URL);
  const priced = await priceItems(db, (payload as { items?: unknown }).items);
  if (!priced.ok) return c.json({ error: priced.error }, priced.status);

  const [row] = await db
    .insert(ordersTable)
    .values({ ...customer.fields, items: priced.items, total: priced.total, source: 'manual' })
    .returning();
  if (row.customerEmail) {
    const menv = await withStore(c.env);
    await inBackground(executionCtx(c), sendMail(menv, orderReceivedMail(menv, toMailOrder(row))));
  }
  return c.json(row, 201);
});

// Admin: change the customer data and products of an order that hasn't taken
// stock yet (pending / confirmed, no PayPal payment). Prices are re-read.
orders.put('/:id', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Not found' }, 404);
  const payload = await c.req.json<unknown>();
  const customer = parseAdminCustomer(payload);
  if (!customer.ok) return c.json({ error: customer.error }, 400);
  const db = getDb(c.env.DATABASE_URL);
  const [current] = await db.select().from(ordersTable).where(eq(ordersTable.id, id));
  if (!current) return c.json({ error: 'Not found' }, 404);
  if (!['pending', 'confirmed'].includes(current.status) || current.paymentRef) {
    return c.json({ error: 'Solo se pueden editar pedidos Pendientes o Confirmados sin pago registrado.' }, 409);
  }
  const priced = await priceItems(db, (payload as { items?: unknown }).items);
  if (!priced.ok) return c.json({ error: priced.error }, priced.status);

  // Only if nobody changed its status meanwhile
  const [row] = await db
    .update(ordersTable)
    .set({ ...customer.fields, items: priced.items, total: priced.total })
    .where(and(eq(ordersTable.id, id), eq(ordersTable.status, current.status), isNull(ordersTable.paymentRef)))
    .returning();
  if (!row) return c.json({ error: 'Otra persona cambió este pedido. Recarga la página.' }, 409);
  return c.json(row);
});

// Admin: internal note on the order (any status; the customer never sees it)
orders.patch('/:id/notes', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'));
  const { adminNotes } = await c.req.json<{ adminNotes?: unknown }>();
  if (!id || typeof adminNotes !== 'string' || adminNotes.length > 2000) return c.json({ error: 'Invalid request' }, 400);
  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db.update(ordersTable).set({ adminNotes }).where(eq(ordersTable.id, id)).returning();
  return row ? c.json(row) : c.json({ error: 'Not found' }, 404);
});

// Statuses where the customer actually bought (for "total spent")
const BOUGHT = new Set(['review', 'paid', 'shipped', 'delivered']);

// Admin: customers built from the orders, grouped by phone number
orders.get('/customers', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt));
  type Customer = {
    key: string; name: string; phone: string; email: string; city: string;
    orders: number; openOrders: number; spent: number; lastOrderAt: Date; firstOrderAt: Date; orderIds: number[];
  };
  const byKey = new Map<string, Customer>();
  for (const o of rows) {
    // Same phone = same customer (the last 10 digits, so "+1" doesn't split them)
    const key = phoneDigits(o.customerPhone).slice(-10) || o.customerEmail.toLowerCase() || `#${o.id}`;
    let cu = byKey.get(key);
    if (!cu) {
      // Rows come newest first: the first one seen has the latest details
      cu = { key, name: o.customerName, phone: o.customerPhone, email: o.customerEmail, city: o.customerCity,
        orders: 0, openOrders: 0, spent: 0, lastOrderAt: o.createdAt, firstOrderAt: o.createdAt, orderIds: [] };
      byKey.set(key, cu);
    }
    if (!cu.email && o.customerEmail) cu.email = o.customerEmail;
    cu.orders += 1;
    cu.orderIds.push(o.id);
    if (['pending', 'confirmed', 'review'].includes(o.status)) cu.openOrders += 1;
    if (BOUGHT.has(o.status)) cu.spent = toMoney(cu.spent + o.total);
    cu.firstOrderAt = o.createdAt;
  }
  return c.json([...byKey.values()].sort((a, b) => b.lastOrderAt.getTime() - a.lastOrderAt.getTime()));
});

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
    receiptSent: row.receiptAt != null,
    canUploadReceipt: row.paymentMethod === 'transfer' && ['pending', 'confirmed'].includes(row.status),
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

  const menv = await withStore(c.env);
  const mailOrder = toMailOrder(row);
  const customerMail = stockShort ? null : statusMail(menv, mailOrder, 'review');
  await inBackground(
    executionCtx(c),
    Promise.all([
      sendMail(menv, paypalStoreMail(menv, mailOrder, captureId, amount, stockShort)),
      customerMail ? sendMail(menv, customerMail) : false,
    ]),
  );
  return c.json({ ok: true, stockShort });
});

// Public: the customer attaches the transfer receipt after ordering (from
// "Sigue tu pedido"), with the order's phone like /track. Sets the stock
// aside and tells the store.
orders.post('/:id/receipt', rateLimit('PUBLIC_LIMITER'), async (c) => {
  const form = await c.req.parseBody().catch(() => null);
  const phone = typeof form?.phone === 'string' ? form.phone : '';
  const file = form?.receipt instanceof File && form.receipt.size > 0 ? form.receipt : null;
  const db = getDb(c.env.DATABASE_URL);
  const row = await orderForCustomer(db, parseId(c.req.param('id')), phone);
  if (!row) return c.json({ error: notFoundMsg }, 404);
  if (row.paymentMethod !== 'transfer' || !['pending', 'confirmed'].includes(row.status)) {
    return c.json({ error: 'Este pedido ya no necesita comprobante.' }, 409);
  }
  if (!file) return c.json({ error: 'Adjunta la foto o el PDF del comprobante.' }, 400);
  if (!RECEIPT_TYPES[file.type]) return c.json({ error: 'El comprobante debe ser una imagen (JPG, PNG, WebP) o un PDF.' }, 400);
  if (file.size > MAX_RECEIPT_BYTES) return c.json({ error: 'El comprobante no puede superar los 5 MB.' }, 400);

  const { saved, stockShort } = await attachReceipt(c.env, db, row, file);
  if (!saved) return c.json({ error: 'No pudimos guardar el comprobante. Intenta de nuevo.' }, 500);

  const menv = await withStore(c.env);
  const mailOrder = toMailOrder(row);
  const customerMail = stockShort ? null : statusMail(menv, mailOrder, 'review');
  await inBackground(
    executionCtx(c),
    Promise.all([sendMail(menv, receiptStoreMail(menv, mailOrder, stockShort)), customerMail ? sendMail(menv, customerMail) : false]),
  );
  return c.json({ ok: true, stockShort });
});

// Admin: download the transfer receipt attached to an order
orders.get('/:id/receipt', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Not found' }, 404);
  // Keys start with the upload time, so the last one listed is the newest
  const listed = await c.env.IMAGES.list({ prefix: receiptPrefix(id) });
  const key = listed.objects.at(-1)?.key;
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
  const menv = await withStore(c.env);
  const mail = statusMail(menv, toMailOrder(row), status);
  if (mail) await inBackground(executionCtx(c), sendMail(menv, mail));
  return c.json(row);
});

export { orders };
