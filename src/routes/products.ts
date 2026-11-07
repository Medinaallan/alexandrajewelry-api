import { Hono } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db';
import { productsTable, productImagesTable, categoriesTable, subcategoriesTable } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { parseFields, parseId } from '../utils/validate';

type Bindings = { DATABASE_URL: string; JWT_SECRET: string };

const products = new Hono<{ Bindings: Bindings }>();

// Only these fields can be written through the API.
const productSpec = {
  code: { type: 'string', min: 1, max: 60 },
  name: { type: 'string', min: 1, max: 200 },
  slug: { type: 'string', min: 1, max: 200 },
  categoryId: { type: 'number', integer: true, min: 1 },
  subcategoryId: { type: 'number', integer: true, min: 1 },
  description: { type: 'string', max: 5000 },
  cost: { type: 'number', min: 0, max: 100_000_000, nullable: true },
  price: { type: 'number', min: 0, max: 100_000_000 },
  tax: { type: 'number', min: 0, max: 100_000_000 },
  stock: { type: 'number', integer: true, min: 0, max: 1_000_000 },
  minStock: { type: 'number', integer: true, min: 0, max: 1_000_000 },
  featured: { type: 'boolean' },
  active: { type: 'boolean' },
} as const;

// Bulk import: the slug is always generated here. Texts are stored only in
// Spanish; the public site is translated in the browser by Google Translate.
const { slug: _slug, ...bulkSpec } = productSpec;
const BULK_REQUIRED = ['code', 'name', 'categoryId', 'subcategoryId', 'price'] as const;
// Rows are saved in batches so one request never carries a huge payload.
export const BULK_MAX = 100;
export const BULK_VALIDATE_MAX = 1000;

/** "Anillo de Oro Rosa" → "anillo-de-oro-rosa" (accents removed). */
export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

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

type ProductRow = typeof productsTable.$inferSelect;

/** What the public site may see: internal fields (cost, minimum stock) are left out. */
export function toPublicProduct<T extends ProductRow>(product: T): Omit<T, 'cost' | 'minStock'> {
  const { cost: _cost, minStock: _minStock, ...rest } = product;
  return rest;
}

// Public: active products with images
products.get('/', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db.select().from(productsTable).where(eq(productsTable.active, true));
  return c.json((await attachImages(db, rows)).map(toPublicProduct));
});

// Admin: all products, with images (cheap now that images are R2 URLs, not base64 blobs)
products.get('/admin/all', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db.select().from(productsTable).orderBy(productsTable.name);
  return c.json(await attachImages(db, rows));
});

// Public: one active product by id or slug
products.get('/:idOrSlug', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const param = c.req.param('idOrSlug');
  const numId = parseId(param);
  let row: ProductRow | undefined;
  if (numId) {
    [row] = await db.select().from(productsTable).where(and(eq(productsTable.id, numId), eq(productsTable.active, true)));
  }
  if (!row) {
    [row] = await db.select().from(productsTable).where(and(eq(productsTable.slug, param), eq(productsTable.active, true)));
  }
  if (!row) return c.json({ error: 'Not found' }, 404);
  const [withImages] = await attachImages(db, [row]);
  return c.json(toPublicProduct(withImages));
});

products.post('/', requireAuth, async (c) => {
  const parsed = parseFields(await c.req.json<unknown>(), productSpec, [
    'code', 'name', 'slug', 'categoryId', 'subcategoryId', 'price',
  ]);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const data = parsed.data;

  const description = data.description ?? '';

  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db
    .insert(productsTable)
    .values({ ...data, description })
    .returning();
  return c.json(row, 201);
});

// Bulk create. All rows are validated first; if any row is wrong nothing is
// inserted, and the response lists every problem by spreadsheet row.
products.post('/bulk', requireAuth, async (c) => {
  const body = await c.req.json<{ products?: unknown; dryRun?: unknown }>();
  const items = body?.products;
  // dryRun only validates, so it can check a whole file before the rows are
  // sent for real in batches of BULK_MAX.
  const dryRun = body?.dryRun === true;
  const max = dryRun ? BULK_VALIDATE_MAX : BULK_MAX;
  if (!Array.isArray(items) || items.length === 0) return c.json({ error: 'products is required' }, 400);
  if (items.length > max) return c.json({ error: `Máximo ${max} productos por envío` }, 400);

  const errors: { row: number; error: string }[] = [];
  const valid: { row: number; data: Exclude<ReturnType<typeof parseBulkRow>, { ok: false }>['data'] }[] = [];
  items.forEach((item, i) => {
    const rawRow = (item as { row?: unknown } | null)?.row;
    const row = typeof rawRow === 'number' && Number.isInteger(rawRow) ? rawRow : i + 1;
    const parsed = parseBulkRow(item);
    if (parsed.ok) valid.push({ row, data: parsed.data });
    else errors.push({ row, error: parsed.error });
  });

  const db = getDb(c.env.DATABASE_URL);
  const codes = valid.map((v) => v.data.code);
  const categoryIds = [...new Set(valid.map((v) => v.data.categoryId))];
  const subcategoryIds = [...new Set(valid.map((v) => v.data.subcategoryId))];
  const [takenCodes, categories, subcategories, slugs] = await Promise.all([
    codes.length ? db.select({ code: productsTable.code }).from(productsTable).where(inArray(productsTable.code, codes)) : [],
    categoryIds.length ? db.select({ id: categoriesTable.id }).from(categoriesTable).where(inArray(categoriesTable.id, categoryIds)) : [],
    subcategoryIds.length
      ? db.select({ id: subcategoriesTable.id, categoryId: subcategoriesTable.categoryId }).from(subcategoriesTable).where(inArray(subcategoriesTable.id, subcategoryIds))
      : [],
    db.select({ slug: productsTable.slug }).from(productsTable),
  ]);
  const existingCodes = new Set(takenCodes.map((r) => r.code));
  const knownCategories = new Set(categories.map((r) => r.id));
  const subcategoryParent = new Map(subcategories.map((r) => [r.id, r.categoryId]));
  const seenCodes = new Set<string>();

  for (const { row, data } of valid) {
    const { code } = data;
    if (existingCodes.has(code)) errors.push({ row, error: `el código "${data.code}" ya existe` });
    else if (seenCodes.has(code)) errors.push({ row, error: `el código "${data.code}" está repetido en el archivo` });
    seenCodes.add(code);
    if (!knownCategories.has(data.categoryId)) errors.push({ row, error: `la categoría ${data.categoryId} no existe` });
    const parent = subcategoryParent.get(data.subcategoryId);
    if (parent === undefined) errors.push({ row, error: `la subcategoría ${data.subcategoryId} no existe` });
    else if (parent !== data.categoryId) {
      errors.push({ row, error: `la subcategoría ${data.subcategoryId} no pertenece a la categoría ${data.categoryId}` });
    }
  }

  errors.sort((a, b) => a.row - b.row);
  // Verification step: report every row with problems so the admin can decide
  // to fix the file or import only the rows that are correct.
  if (dryRun) {
    const badRows = new Set(errors.map((e) => e.row));
    return c.json({ valid: valid.filter((v) => !badRows.has(v.row)).length, errors });
  }
  if (errors.length) {
    const summary = errors.map((e) => `Fila ${e.row}: ${e.error}`).join('\n');
    return c.json({ error: summary, errors }, 400);
  }

  const usedSlugs = new Set(slugs.map((r) => r.slug));
  const values = valid.map(({ data }) => {
    const base = slugify(data.name) || slugify(data.code) || 'producto';
    let slug = base;
    for (let n = 2; usedSlugs.has(slug); n++) slug = `${base}-${n}`;
    usedSlugs.add(slug);
    return { ...data, slug, description: data.description ?? '' };
  });

  // A single INSERT: either every row is stored or none is.
  const rows = await db.insert(productsTable).values(values).returning();
  return c.json({ created: rows.length, products: rows }, 201);
});

function parseBulkRow(item: unknown) {
  const parsed = parseFields(item, bulkSpec, BULK_REQUIRED);
  if (!parsed.ok) return parsed;
  return { ok: true as const, data: parsed.data };
}

products.put('/:id', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Not found' }, 404);
  const parsed = parseFields(await c.req.json<unknown>(), productSpec);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const data = parsed.data;

  const db = getDb(c.env.DATABASE_URL);
  const [existing] = await db.select({ id: productsTable.id }).from(productsTable).where(eq(productsTable.id, id));
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const [row] = await db
    .update(productsTable)
    .set({ ...data, updatedAt: new Date() })
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
