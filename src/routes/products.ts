import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { productsTable, productImagesTable } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { translateToEnglish } from '../utils/translate';

type Bindings = { DATABASE_URL: string; JWT_SECRET: string };

const products = new Hono<{ Bindings: Bindings }>();

async function attachImages(db: ReturnType<typeof getDb>, rows: (typeof productsTable.$inferSelect)[]) {
  return Promise.all(
    rows.map(async (p) => {
      const images = await db
        .select()
        .from(productImagesTable)
        .where(eq(productImagesTable.productId, p.id))
        .orderBy(productImagesTable.displayOrder);
      return { ...p, images };
    }),
  );
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
  const numId = Number(param);
  let row: (typeof productsTable.$inferSelect) | undefined;
  if (!isNaN(numId)) {
    [row] = await db.select().from(productsTable).where(eq(productsTable.id, numId));
  }
  if (!row) {
    [row] = await db.select().from(productsTable).where(eq(productsTable.slug, param));
  }
  if (!row) return c.json({ error: 'Not found' }, 404);
  const images = await db
    .select()
    .from(productImagesTable)
    .where(eq(productImagesTable.productId, row.id))
    .orderBy(productImagesTable.displayOrder);
  return c.json({ ...row, images });
});

products.post('/', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const body = await c.req.json<{
    code: string; name: string; slug: string;
    categoryId: number; subcategoryId: number;
    description?: string; cost?: number; price: number;
    tax?: number; stock?: number; minStock?: number; featured?: boolean;
  }>();
  const nameEn = await translateToEnglish(body.name);
  const descriptionEn = body.description ? await translateToEnglish(body.description) : '';
  const [row] = await db
    .insert(productsTable)
    .values({ ...body, nameEn, description: body.description ?? '', descriptionEn })
    .returning();
  return c.json(row, 201);
});

products.put('/:id', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const id = Number(c.req.param('id'));
  const body = await c.req.json<Record<string, unknown>>();
  const updates: Record<string, unknown> = { ...body, updatedAt: new Date() };
  if (body.name) updates.nameEn = await translateToEnglish(body.name as string);
  if (body.description !== undefined) {
    updates.descriptionEn = body.description ? await translateToEnglish(body.description as string) : '';
  }
  const [row] = await db.update(productsTable).set(updates).where(eq(productsTable.id, id)).returning();
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

products.patch('/:id/toggle', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const id = Number(c.req.param('id'));
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
  const db = getDb(c.env.DATABASE_URL);
  await db.delete(productsTable).where(eq(productsTable.id, Number(c.req.param('id'))));
  return c.json({ success: true });
});

export { products };

