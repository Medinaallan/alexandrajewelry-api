import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import { getDb } from '../db';
import { stockProductsTable, productsTable } from '../db/schema';
import { requireAuth } from '../middleware/auth';

type Bindings = { DATABASE_URL: string; JWT_SECRET: string };
type Variables = { username: string };

const stock = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// All products with current stock levels
stock.get('/products', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db
    .select({
      id: productsTable.id,
      code: productsTable.code,
      name: productsTable.name,
      price: productsTable.price,
      stock: productsTable.stock,
      minStock: productsTable.minStock,
      active: productsTable.active,
    })
    .from(productsTable)
    .orderBy(productsTable.name);
  return c.json(rows);
});

// All stock movements (with product info)
stock.get('/', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db
    .select({
      id: stockProductsTable.id,
      productId: stockProductsTable.productId,
      productName: productsTable.name,
      productCode: productsTable.code,
      currentStock: productsTable.stock,
      quantity: stockProductsTable.quantity,
      type: stockProductsTable.type,
      notes: stockProductsTable.notes,
      createdBy: stockProductsTable.createdBy,
      createdAt: stockProductsTable.createdAt,
    })
    .from(stockProductsTable)
    .innerJoin(productsTable, eq(stockProductsTable.productId, productsTable.id))
    .orderBy(desc(stockProductsTable.createdAt));
  return c.json(rows);
});

// Movements for a specific product
stock.get('/product/:productId', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const productId = Number(c.req.param('productId'));
  const rows = await db
    .select()
    .from(stockProductsTable)
    .where(eq(stockProductsTable.productId, productId))
    .orderBy(desc(stockProductsTable.createdAt));
  return c.json(rows);
});

// Register a stock movement
stock.post('/', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const username = c.get('username');
  const body = await c.req.json<{
    productId: number;
    quantity: number;
    type?: string;
    notes?: string;
  }>();

  if (!body.productId || body.quantity === undefined) {
    return c.json({ error: 'productId and quantity are required' }, 400);
  }
  if (!body.notes || !body.notes.trim()) {
    return c.json({ error: 'notes are required' }, 400);
  }

  const [product] = await db.select().from(productsTable).where(eq(productsTable.id, body.productId));
  if (!product) return c.json({ error: 'Product not found' }, 404);

  const type = body.type ?? 'entry';

  // `quantity` stored on the movement always represents the actual change
  // applied to the product's stock (positive = added, negative = removed),
  // regardless of how the admin entered the value for each movement type.
  let newStock: number;
  let delta: number;
  if (type === 'adjustment') {
    // For adjustments, `body.quantity` is the new absolute stock value.
    newStock = Math.max(0, body.quantity);
    delta = newStock - product.stock;
  } else if (type === 'return') {
    // Returns always remove stock.
    delta = -Math.abs(body.quantity);
    newStock = Math.max(0, product.stock + delta);
  } else {
    // Entries always add stock.
    delta = Math.abs(body.quantity);
    newStock = product.stock + delta;
  }

  const [movement] = await db
    .insert(stockProductsTable)
    .values({
      productId: body.productId,
      quantity: delta,
      type,
      notes: body.notes,
      createdBy: username ?? '',
    })
    .returning();

  await db
    .update(productsTable)
    .set({ stock: newStock, updatedAt: new Date() })
    .where(eq(productsTable.id, body.productId));

  return c.json({ ...movement, newStock }, 201);
});

export { stock };
