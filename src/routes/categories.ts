import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { categoriesTable, subcategoriesTable, productsTable } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { translateToEnglish } from '../utils/translate';

type Bindings = { DATABASE_URL: string; JWT_SECRET: string };

const categories = new Hono<{ Bindings: Bindings }>();

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
  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db
    .select()
    .from(categoriesTable)
    .where(eq(categoriesTable.id, Number(c.req.param('id'))));
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

categories.post('/', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const body = await c.req.json<{ name: string; slug: string; image?: string; description?: string }>();
  const nameEn = await translateToEnglish(body.name);
  const descriptionEn = body.description ? await translateToEnglish(body.description) : '';
  const [row] = await db
    .insert(categoriesTable)
    .values({ ...body, nameEn, description: body.description ?? '', descriptionEn })
    .returning();
  return c.json(row, 201);
});

categories.put('/:id', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const id = Number(c.req.param('id'));
  const body = await c.req.json<Partial<{ name: string; slug: string; image: string; description: string; active: boolean }>>();
  const updates: Record<string, unknown> = { ...body };
  if (body.name) updates.nameEn = await translateToEnglish(body.name);
  if (body.description !== undefined) updates.descriptionEn = body.description ? await translateToEnglish(body.description) : '';
  const [row] = await db.update(categoriesTable).set(updates).where(eq(categoriesTable.id, id)).returning();
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

// Toggle active/inactive
categories.patch('/:id/toggle', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const id = Number(c.req.param('id'));
  const [current] = await db.select({ active: categoriesTable.active }).from(categoriesTable).where(eq(categoriesTable.id, id));
  if (!current) return c.json({ error: 'Not found' }, 404);
  const [row] = await db.update(categoriesTable).set({ active: !current.active }).where(eq(categoriesTable.id, id)).returning();
  return c.json(row);
});

// Delete only when no subcategories or products exist
categories.delete('/:id', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const id = Number(c.req.param('id'));
  const [sub] = await db.select({ id: subcategoriesTable.id }).from(subcategoriesTable).where(eq(subcategoriesTable.categoryId, id));
  if (sub) return c.json({ error: 'No se puede eliminar: la categoría tiene subcategorías' }, 409);
  const [prod] = await db.select({ id: productsTable.id }).from(productsTable).where(eq(productsTable.categoryId, id));
  if (prod) return c.json({ error: 'No se puede eliminar: la categoría tiene productos' }, 409);
  await db.delete(categoriesTable).where(eq(categoriesTable.id, id));
  return c.json({ success: true });
});

export { categories };
