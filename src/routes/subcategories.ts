import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../db';
import { subcategoriesTable, productsTable } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { resolveEnglish } from '../utils/translate';
import { parseFields, parseId } from '../utils/validate';

type Bindings = { DATABASE_URL: string; JWT_SECRET: string };

const subcategories = new Hono<{ Bindings: Bindings }>();

// Only these fields can be written through the API.
const subcategorySpec = {
  categoryId: { type: 'number', integer: true, min: 1 },
  name: { type: 'string', min: 1, max: 120 },
  nameEn: { type: 'string', max: 120 },
  slug: { type: 'string', min: 1, max: 160 },
  description: { type: 'string', max: 2000 },
  descriptionEn: { type: 'string', max: 2000 },
  active: { type: 'boolean' },
} as const;

// Public: active subcategories, optionally filtered by category
subcategories.get('/', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const categoryId = parseId(c.req.query('categoryId'));
  const rows = await db
    .select()
    .from(subcategoriesTable)
    .where(
      categoryId
        ? and(eq(subcategoriesTable.active, true), eq(subcategoriesTable.categoryId, categoryId))
        : eq(subcategoriesTable.active, true),
    );
  return c.json(rows);
});

// Admin: all subcategories
subcategories.get('/admin/all', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db.select().from(subcategoriesTable).orderBy(subcategoriesTable.name);
  return c.json(rows);
});

subcategories.get('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Not found' }, 404);
  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db.select().from(subcategoriesTable).where(eq(subcategoriesTable.id, id));
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

subcategories.post('/', requireAuth, async (c) => {
  const parsed = parseFields(await c.req.json<unknown>(), subcategorySpec, ['categoryId', 'name', 'slug']);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const data = parsed.data;

  const description = data.description ?? '';
  const nameEn = (await resolveEnglish({ es: data.name, en: data.nameEn })) ?? '';
  const descriptionEn = (await resolveEnglish({ es: description, en: data.descriptionEn })) ?? '';

  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db
    .insert(subcategoriesTable)
    .values({ ...data, nameEn, description, descriptionEn })
    .returning();
  return c.json(row, 201);
});

subcategories.put('/:id', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Not found' }, 404);
  const parsed = parseFields(await c.req.json<unknown>(), subcategorySpec);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { nameEn: nameEnInput, descriptionEn: descriptionEnInput, ...data } = parsed.data;

  const db = getDb(c.env.DATABASE_URL);
  const [existing] = await db.select().from(subcategoriesTable).where(eq(subcategoriesTable.id, id));
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const nameEn = await resolveEnglish(
    { es: data.name, en: nameEnInput },
    { es: existing.name, en: existing.nameEn },
  );
  const descriptionEn = await resolveEnglish(
    { es: data.description, en: descriptionEnInput },
    { es: existing.description, en: existing.descriptionEn },
  );
  const updates = {
    ...data,
    ...(nameEn !== undefined && { nameEn }),
    ...(descriptionEn !== undefined && { descriptionEn }),
  };
  if (Object.keys(updates).length === 0) return c.json(existing);

  const [row] = await db.update(subcategoriesTable).set(updates).where(eq(subcategoriesTable.id, id)).returning();
  return c.json(row);
});

subcategories.patch('/:id/toggle', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Not found' }, 404);
  const db = getDb(c.env.DATABASE_URL);
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
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Not found' }, 404);
  const db = getDb(c.env.DATABASE_URL);
  const [prod] = await db.select({ id: productsTable.id }).from(productsTable).where(eq(productsTable.subcategoryId, id));
  if (prod) return c.json({ error: 'No se puede eliminar: la subcategoría tiene productos' }, 409);
  await db.delete(subcategoriesTable).where(eq(subcategoriesTable.id, id));
  return c.json({ success: true });
});

export { subcategories };
