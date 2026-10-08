import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '../db';
import { productsTable, productImagesTable } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { resolveEnglish } from '../utils/translate';
import { parseFields, parseId } from '../utils/validate';

type Bindings = { DATABASE_URL: string; JWT_SECRET: string };

const products = new Hono<{ Bindings: Bindings }>();

// Only these fields can be written through the API.
const productSpec = {
  code: { type: 'string', min: 1, max: 60 },
  name: { type: 'string', min: 1, max: 200 },
  nameEn: { type: 'string', max: 200 },
  slug: { type: 'string', min: 1, max: 200 },
  categoryId: { type: 'number', integer: true, min: 1 },
  subcategoryId: { type: 'number', integer: true, min: 1 },
  description: { type: 'string', max: 5000 },
  descriptionEn: { type: 'string', max: 5000 },
  cost: { type: 'number', min: 0, max: 100_000_000, nullable: true },
  price: { type: 'number', min: 0, max: 100_000_000 },
  tax: { type: 'number', min: 0, max: 100_000_000 },
  stock: { type: 'number', integer: true, min: 0, max: 1_000_000 },
  minStock: { type: 'number', integer: true, min: 0, max: 1_000_000 },
  featured: { type: 'boolean' },
  active: { type: 'boolean' },
} as const;

// One query for the images of every product in `rows`
async function attachImages(db: ReturnType<typeof getDb>, rows: (typeof productsTable.$inferSelect)[]) {
  if (rows.length === 0) return [];
  const images = await db
    .select()
    .from(productImagesTable)
    .where(inArray(productImagesTable.productId, rows.map((p) => p.id)))
    .orderBy(productImagesTable.displayOrder, productImagesTable.id);
  const byProduct = new Map<number, (typeof productImagesTable.$inferSelect)[]>();
  for (const image of images) {
    const list = byProduct.get(image.productId);
    if (list) list.push(image);
    else byProduct.set(image.productId, [image]);
  }
  return rows.map((p) => ({ ...p, images: byProduct.get(p.id) ?? [] }));
}

// Public: active products with images
products.get('/', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db.select().from(productsTable).where(eq(productsTable.active, true));
  return c.json(await attachImages(db, rows));
});

// Admin: all products, with images (cheap now that images are R2 URLs, not base64 blobs)
products.get('/admin/all', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db.select().from(productsTable).orderBy(productsTable.name);
  return c.json(await attachImages(db, rows));
});

products.get('/:idOrSlug', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const param = c.req.param('idOrSlug');
  const numId = parseId(param);
  let row: (typeof productsTable.$inferSelect) | undefined;
  if (numId) {
    [row] = await db.select().from(productsTable).where(eq(productsTable.id, numId));
  }
  if (!row) {
    [row] = await db.select().from(productsTable).where(eq(productsTable.slug, param));
  }
  if (!row) return c.json({ error: 'Not found' }, 404);
  const [withImages] = await attachImages(db, [row]);
  return c.json(withImages);
});

products.post('/', requireAuth, async (c) => {
  const parsed = parseFields(await c.req.json<unknown>(), productSpec, [
    'code', 'name', 'slug', 'categoryId', 'subcategoryId', 'price',
  ]);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const data = parsed.data;

  const description = data.description ?? '';
  const nameEn = (await resolveEnglish({ es: data.name, en: data.nameEn })) ?? '';
  const descriptionEn = (await resolveEnglish({ es: description, en: data.descriptionEn })) ?? '';

  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db
    .insert(productsTable)
    .values({ ...data, nameEn, description, descriptionEn })
    .returning();
  return c.json(row, 201);
});

products.put('/:id', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Not found' }, 404);
  const parsed = parseFields(await c.req.json<unknown>(), productSpec);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { nameEn: nameEnInput, descriptionEn: descriptionEnInput, ...data } = parsed.data;

  const db = getDb(c.env.DATABASE_URL);
  const [existing] = await db.select().from(productsTable).where(eq(productsTable.id, id));
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const nameEn = await resolveEnglish(
    { es: data.name, en: nameEnInput },
    { es: existing.name, en: existing.nameEn },
  );
  const descriptionEn = await resolveEnglish(
    { es: data.description, en: descriptionEnInput },
    { es: existing.description, en: existing.descriptionEn },
  );

  const [row] = await db
    .update(productsTable)
    .set({
      ...data,
      ...(nameEn !== undefined && { nameEn }),
      ...(descriptionEn !== undefined && { descriptionEn }),
      updatedAt: new Date(),
    })
    .where(eq(productsTable.id, id))
    .returning();
  return c.json(row);
});

products.patch('/:id/toggle', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Not found' }, 404);
  const db = getDb(c.env.DATABASE_URL);
  const [current] = await db.select({ active: productsTable.active }).from(productsTable).where(eq(productsTable.id, id));
  if (!current) return c.json({ error: 'Not found' }, 404);
  const [row] = await db
    .update(productsTable)
    .set({ active: !current.active, updatedAt: new Date() })
    .where(eq(productsTable.id, id))
    .returning();
  return c.json(row);
});

products.delete('/:id', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Not found' }, 404);
  const db = getDb(c.env.DATABASE_URL);
  await db.delete(productsTable).where(eq(productsTable.id, id));
  return c.json({ success: true });
});

export { products };
