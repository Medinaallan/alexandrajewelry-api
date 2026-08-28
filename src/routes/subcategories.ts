import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { subcategoriesTable, productsTable } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { translateToEnglish } from '../utils/translate';

type Bindings = { DATABASE_URL: string; JWT_SECRET: string };

const subcategories = new Hono<{ Bindings: Bindings }>();

// Public: active subcategories, optionally filtered by category
subcategories.get('/', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const categoryId = c.req.query('categoryId');
  if (categoryId) {
    const rows = await db
      .select()
      .from(subcategoriesTable)
      .where(eq(subcategoriesTable.categoryId, Number(categoryId)));
    return c.json(rows);
  }
  const rows = await db.select().from(subcategoriesTable).where(eq(subcategoriesTable.active, true));
  return c.json(rows);
});

// Admin: all subcategories
subcategories.get('/admin/all', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db.select().from(subcategoriesTable).orderBy(subcategoriesTable.name);
  return c.json(rows);
});

subcategories.get('/:id', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db
    .select()
    .from(subcategoriesTable)
    .where(eq(subcategoriesTable.id, Number(c.req.param('id'))));
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

subcategories.post('/', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const body = await c.req.json<{ categoryId: number; name: string; slug: string; description?: string }>();
  const nameEn = await translateToEnglish(body.name);
  const descriptionEn = body.description ? await translateToEnglish(body.description) : '';
  const [row] = await db
    .insert(subcategoriesTable)
    .values({ ...body, nameEn, description: body.description ?? '', descriptionEn })
    .returning();
  return c.json(row, 201);
});

subcategories.put('/:id', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const id = Number(c.req.param('id'));
  const body = await c.req.json<Partial<{ categoryId: number; name: string; slug: string; description: string; active: boolean }>>();
  const updates: Record<string, unknown> = { ...body };
  if (body.name) updates.nameEn = await translateToEnglish(body.name);
  if (body.description !== undefined) {
    updates.descriptionEn = body.description ? await translateToEnglish(body.description) : '';
  }
  const [row] = await db.update(subcategoriesTable).set(updates).where(eq(subcategoriesTable.id, id)).returning();
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

subcategories.patch('/:id/toggle', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const id = Number(c.req.param('id'));
  const [current] = await db.select({ active: subcategoriesTable.active }).from(subcategoriesTable).where(eq(subcategoriesTable.id, id));
  if (!current) return c.json({ error: 'Not found' }, 404);
  const [row] = await db
    .update(subcategoriesTable)
    .set({ active: !current.active })
    .where(eq(subcategoriesTable.id, id))
    .returning();
  return c.json(row);
});

// Delete only when no products exist
subcategories.delete('/:id', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const id = Number(c.req.param('id'));
  const [prod] = await db.select({ id: productsTable.id }).from(productsTable).where(eq(productsTable.subcategoryId, id));
  if (prod) return c.json({ error: 'No se puede eliminar: la subcategoría tiene productos' }, 409);
  await db.delete(subcategoriesTable).where(eq(subcategoriesTable.id, id));
  return c.json({ success: true });
});

export { subcategories };
