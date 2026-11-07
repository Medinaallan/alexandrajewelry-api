import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { categoriesTable, subcategoriesTable, productsTable } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { parseFields, parseId } from '../utils/validate';

type Bindings = { DATABASE_URL: string; JWT_SECRET: string };

const categories = new Hono<{ Bindings: Bindings }>();

// Only these fields can be written through the API.
const categorySpec = {
  name: { type: 'string', min: 1, max: 120 },
  slug: { type: 'string', min: 1, max: 160 },
  image: { type: 'string', max: 2000 },
  description: { type: 'string', max: 2000 },
  active: { type: 'boolean' },
} as const;

// Public: only active categories
categories.get('/', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db.select().from(categoriesTable).where(eq(categoriesTable.active, true));
  return c.json(rows);
});

// Admin: all categories
categories.get('/admin/all', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db.select().from(categoriesTable).orderBy(categoriesTable.name);
  return c.json(rows);
});

categories.get('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Not found' }, 404);
  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db.select().from(categoriesTable).where(eq(categoriesTable.id, id));
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

categories.post('/', requireAuth, async (c) => {
  const parsed = parseFields(await c.req.json<unknown>(), categorySpec, ['name', 'slug']);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const data = parsed.data;

  const description = data.description ?? '';

  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db
    .insert(categoriesTable)
    .values({ ...data, description })
    .returning();
  return c.json(row, 201);
});

categories.put('/:id', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Not found' }, 404);
  const parsed = parseFields(await c.req.json<unknown>(), categorySpec);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const data = parsed.data;

  const db = getDb(c.env.DATABASE_URL);
  const [existing] = await db.select().from(categoriesTable).where(eq(categoriesTable.id, id));
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const updates = {
    ...data,
  };
  if (Object.keys(updates).length === 0) return c.json(existing);

  const [row] = await db.update(categoriesTable).set(updates).where(eq(categoriesTable.id, id)).returning();
  return c.json(row);
});

// Toggle active/inactive
categories.patch('/:id/toggle', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Not found' }, 404);
  const db = getDb(c.env.DATABASE_URL);
  const [current] = await db.select({ active: categoriesTable.active }).from(categoriesTable).where(eq(categoriesTable.id, id));
  if (!current) return c.json({ error: 'Not found' }, 404);
  const [row] = await db.update(categoriesTable).set({ active: !current.active }).where(eq(categoriesTable.id, id)).returning();
  return c.json(row);
});

// Delete only when no subcategories or products exist
categories.delete('/:id', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Not found' }, 404);
  const db = getDb(c.env.DATABASE_URL);
  const [sub] = await db.select({ id: subcategoriesTable.id }).from(subcategoriesTable).where(eq(subcategoriesTable.categoryId, id));
  if (sub) return c.json({ error: 'No se puede eliminar: la categoría tiene subcategorías' }, 409);
  const [prod] = await db.select({ id: productsTable.id }).from(productsTable).where(eq(productsTable.categoryId, id));
  if (prod) return c.json({ error: 'No se puede eliminar: la categoría tiene productos' }, 409);
  await db.delete(categoriesTable).where(eq(categoriesTable.id, id));
  return c.json({ success: true });
});

export { categories };
