import { Hono } from 'hono';
import { eq, desc, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { salesTable, productsTable } from '../db/schema';
import { requireAuth } from '../middleware/auth';

type Bindings = { DATABASE_URL: string; JWT_SECRET: string };
type Variables = { username: string };

const sales = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// List all sales
sales.get('/', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db
    .select()
    .from(salesTable)
    .orderBy(desc(salesTable.createdAt));
  return c.json(rows);
});

// Sales report grouped by product
sales.get('/report', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db
    .select({
      productId: salesTable.productId,
      productName: salesTable.productName,
      totalQuantity: sql<number>`cast(sum(${salesTable.quantity}) as int)`,
      totalRevenue: sql<number>`sum(${salesTable.total})`,
      salesCount: sql<number>`cast(count(*) as int)`,
    })
    .from(salesTable)
    .groupBy(salesTable.productId, salesTable.productName)
    .orderBy(desc(sql`sum(${salesTable.total})`));
  return c.json(rows);
});

// Register a sale
sales.post('/', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const username = c.get('username');
  const body = await c.req.json<{
    productId: number;
    quantity: number;
    unitPrice?: number;
    notes?: string;
  }>();

  if (!body.productId || !body.quantity || body.quantity < 1) {
    return c.json({ error: 'productId and quantity >= 1 are required' }, 400);
  }

  const [product] = await db.select().from(productsTable).where(eq(productsTable.id, body.productId));
  if (!product) return c.json({ error: 'Product not found' }, 404);
  if (product.stock < body.quantity) {
    return c.json({ error: 'Insufficient stock', available: product.stock }, 400);
  }

  const unitPrice = body.unitPrice ?? product.price;
  const total = unitPrice * body.quantity;

  const [sale] = await db
    .insert(salesTable)
    .values({
      productId: body.productId,
      productName: product.name,
      quantity: body.quantity,
      unitPrice,
      total,
      notes: body.notes ?? '',
      soldBy: username ?? '',
    })
    .returning();

  await db
    .update(productsTable)
    .set({ stock: product.stock - body.quantity, updatedAt: new Date() })
    .where(eq(productsTable.id, body.productId));

  return c.json(sale, 201);
});

export { sales };
