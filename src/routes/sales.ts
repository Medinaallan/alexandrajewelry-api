import { Hono } from 'hono';
import { desc, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { salesTable, productsTable } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { registerSales, InsufficientStockError, type SaleLine } from '../db/inventory';
import { parseFields } from '../utils/validate';

type Bindings = { DATABASE_URL: string; JWT_SECRET: string };
type Variables = { username: string };

const sales = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const MAX_LINES = 100;

const lineSpec = {
  productId: { type: 'number', integer: true, min: 1 },
  quantity: { type: 'number', integer: true, min: 1, max: 100_000 },
  unitPrice: { type: 'number', min: 0, max: 100_000_000 },
  notes: { type: 'string', max: 500 },
} as const;

type SaleResult = { ok: true; sales: Awaited<ReturnType<typeof registerSales>> } | { ok: false; status: 400 | 404 | 409; error: string };

async function sell(db: ReturnType<typeof getDb>, rawLines: unknown[], soldBy: string): Promise<SaleResult> {
  if (rawLines.length === 0 || rawLines.length > MAX_LINES) {
    return { ok: false, status: 400, error: 'Agrega al menos un producto a la venta.' };
  }
  const lines: SaleLine[] = [];
  for (const raw of rawLines) {
    const parsed = parseFields(raw, lineSpec, ['productId', 'quantity']);
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
    lines.push(parsed.data);
  }
  const ids = lines.map((l) => l.productId);
  if (new Set(ids).size !== ids.length) {
    return { ok: false, status: 400, error: 'Un producto aparece más de una vez en la venta.' };
  }

  // Friendly errors for the common cases; registerSales re-checks atomically.
  const products = await db
    .select({ id: productsTable.id, name: productsTable.name, stock: productsTable.stock })
    .from(productsTable)
    .where(inArray(productsTable.id, ids));
  for (const line of lines) {
    const product = products.find((p) => p.id === line.productId);
    if (!product) return { ok: false, status: 404, error: 'Producto no encontrado.' };
    if (product.stock < line.quantity) {
      return { ok: false, status: 409, error: `Stock insuficiente para "${product.name}" (disponible: ${product.stock}).` };
    }
  }

  try {
    return { ok: true, sales: await registerSales(db, lines, soldBy) };
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      return { ok: false, status: 409, error: 'El stock cambió mientras registrabas la venta. Revisa las cantidades e intenta de nuevo.' };
    }
    throw err;
  }
}

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
      totalRevenue: sql<number>`cast(sum(${salesTable.total}) as float8)`,
      salesCount: sql<number>`cast(count(*) as int)`,
    })
    .from(salesTable)
    .groupBy(salesTable.productId, salesTable.productName)
    .orderBy(desc(sql`sum(${salesTable.total})`));
  return c.json(rows);
});

// Register a sale of a single product
sales.post('/', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const body = await c.req.json<unknown>();
  const result = await sell(db, [body], c.get('username') ?? '');
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result.sales[0], 201);
});

// Register a sale with several products — all of them are sold, or none
sales.post('/batch', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const body = await c.req.json<{ lines?: unknown; notes?: unknown }>();
  if (!Array.isArray(body?.lines)) return c.json({ error: 'lines is required' }, 400);
  const notes = typeof body.notes === 'string' ? body.notes : undefined;
  const lines = body.lines.map((l: unknown) =>
    typeof l === 'object' && l !== null ? { notes, ...l } : l,
  );
  const result = await sell(db, lines, c.get('username') ?? '');
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result.sales, 201);
});

export { sales };
