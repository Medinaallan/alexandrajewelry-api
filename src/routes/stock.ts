import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import { getDb } from '../db';
import { stockProductsTable, productsTable } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { applyStockMovement, type MovementType } from '../db/inventory';
import { parseFields, parseId } from '../utils/validate';

type Bindings = { DATABASE_URL: string; JWT_SECRET: string };
type Variables = { username: string };

const stock = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const MOVEMENT_TYPES: readonly MovementType[] = ['entry', 'adjustment', 'return'];

const movementSpec = {
  productId: { type: 'number', integer: true, min: 1 },
  quantity: { type: 'number', integer: true, min: -1_000_000, max: 1_000_000 },
  type: { type: 'string', max: 20 },
  notes: { type: 'string', min: 1, max: 500 },
} as const;

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
  const productId = parseId(c.req.param('productId'));
  if (!productId) return c.json({ error: 'Not found' }, 404);
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db
    .select()
    .from(stockProductsTable)
    .where(eq(stockProductsTable.productId, productId))
    .orderBy(desc(stockProductsTable.createdAt));
  return c.json(rows);
});

// Register a stock movement
stock.post('/', requireAuth, async (c) => {
  const parsed = parseFields(await c.req.json<unknown>(), movementSpec, ['productId', 'quantity', 'notes']);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { productId, quantity, notes } = parsed.data;

  const type = (parsed.data.type ?? 'entry') as MovementType;
  if (!MOVEMENT_TYPES.includes(type)) return c.json({ error: 'Invalid movement type' }, 400);
  // An adjustment sets the stock to `quantity`, so it can't be negative.
  if (type === 'adjustment' && quantity < 0) return c.json({ error: 'quantity must be at least 0' }, 400);

  const movement = await applyStockMovement(getDb(c.env.DATABASE_URL), {
    productId,
    quantity,
    type,
    notes,
    createdBy: c.get('username') ?? '',
  });
  if (!movement) return c.json({ error: 'Product not found' }, 404);
  return c.json(movement, 201);
});

export { stock };
