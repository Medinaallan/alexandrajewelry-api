import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { ordersTable } from '../db/schema';
import { requireAuth } from '../middleware/auth';

type Bindings = { DATABASE_URL: string; JWT_SECRET: string };

type OrderBody = {
  name: string;
  phone: string;
  address: string;
  city: string;
  notes: string;
  paymentMethod: string;
  items: unknown;
  total: number;
};

const orders = new Hono<{ Bindings: Bindings }>();

// Admin: list all orders
orders.get('/', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db
    .select()
    .from(ordersTable)
    .orderBy(ordersTable.createdAt);
  return c.json(rows);
});

// Public: create order (called at checkout)
orders.post('/', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const body = await c.req.json<OrderBody>();
  const [row] = await db
    .insert(ordersTable)
    .values({
      customerName: body.name,
      customerPhone: body.phone,
      customerAddress: body.address,
      customerCity: body.city,
      notes: body.notes,
      paymentMethod: body.paymentMethod,
      items: body.items,
      total: body.total,
    })
    .returning();
  return c.json(row, 201);
});

// Admin: update order status
orders.patch('/:id/status', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const { status } = await c.req.json<{ status: string }>();
  const [row] = await db
    .update(ordersTable)
    .set({ status })
    .where(eq(ordersTable.id, Number(c.req.param('id'))))
    .returning();
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

export { orders };
