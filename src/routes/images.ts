import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../db';
import { productImagesTable, productsTable } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { parseFields, parseId, safeFilename } from '../utils/validate';

type Bindings = { DATABASE_URL: string; JWT_SECRET: string; IMAGES: R2Bucket; R2_PUBLIC_URL: string };

const images = new Hono<{ Bindings: Bindings }>();

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'];

const imageSpec = {
  filename: { type: 'string', min: 1, max: 255 },
  // base64 adds ~33% on top of the binary size
  data: { type: 'string', max: Math.ceil(MAX_IMAGE_BYTES * 1.4) },
  displayOrder: { type: 'number', integer: true, min: 0, max: 1000 },
} as const;

function dataUriToBytes(dataUri: string): { bytes: Uint8Array; contentType: string } | null {
  const match = dataUri.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  const [, contentType, base64] = match;
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes, contentType };
  } catch {
    return null;
  }
}

// Get all images for a product
images.get('/product/:productId', async (c) => {
  const productId = parseId(c.req.param('productId'));
  if (!productId) return c.json({ error: 'Not found' }, 404);
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db
    .select()
    .from(productImagesTable)
    .where(eq(productImagesTable.productId, productId))
    .orderBy(productImagesTable.displayOrder);
  return c.json(rows);
});

// Add image to product — body: { filename, data?, displayOrder? }
// 'data' is a base64 data URI (e.g. "data:image/webp;base64,...") — uploaded to R2, only the public URL is stored
images.post('/product/:productId', requireAuth, async (c) => {
  const productId = parseId(c.req.param('productId'));
  if (!productId) return c.json({ error: 'Not found' }, 404);
  const parsed = parseFields(await c.req.json<unknown>(), imageSpec, ['filename']);
  if (!parsed.ok) {
    const tooBig = parsed.error === 'data is too long';
    return c.json({ error: tooBig ? 'La imagen no puede superar los 5 MB.' : parsed.error }, 400);
  }
  const body = parsed.data;

  const db = getDb(c.env.DATABASE_URL);
  const [product] = await db.select({ id: productsTable.id }).from(productsTable).where(eq(productsTable.id, productId));
  if (!product) return c.json({ error: 'Product not found' }, 404);

  let publicUrl: string | null = null;
  if (body.data) {
    const decoded = dataUriToBytes(body.data);
    if (!decoded || !IMAGE_TYPES.includes(decoded.contentType)) {
      return c.json({ error: 'Formato de imagen no permitido. Usa JPG, PNG, WebP, AVIF o GIF.' }, 400);
    }
    if (decoded.bytes.length > MAX_IMAGE_BYTES) return c.json({ error: 'La imagen no puede superar los 5 MB.' }, 400);
    const key = `products/${productId}/${crypto.randomUUID()}-${safeFilename(body.filename)}`;
    await c.env.IMAGES.put(key, decoded.bytes, { httpMetadata: { contentType: decoded.contentType } });
    publicUrl = `${c.env.R2_PUBLIC_URL}/${key}`;
  }

  const [row] = await db
    .insert(productImagesTable)
    .values({ productId, filename: body.filename, data: publicUrl, displayOrder: body.displayOrder ?? 0 })
    .returning();
  return c.json(row, 201);
});

// Delete an image record (and its R2 object, if any)
images.delete('/:id', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Not found' }, 404);
  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db.select().from(productImagesTable).where(eq(productImagesTable.id, id));
  if (row?.data?.startsWith(c.env.R2_PUBLIC_URL)) {
    const key = row.data.slice(c.env.R2_PUBLIC_URL.length + 1);
    await c.env.IMAGES.delete(key);
  }
  await db.delete(productImagesTable).where(eq(productImagesTable.id, id));
  return c.json({ success: true });
});

// Reorder images: body: { order: [{ id, displayOrder }] }
images.patch('/product/:productId/reorder', requireAuth, async (c) => {
  const productId = parseId(c.req.param('productId'));
  if (!productId) return c.json({ error: 'Not found' }, 404);
  const { order } = await c.req.json<{ order?: unknown }>();
  if (!Array.isArray(order) || order.length > 100) return c.json({ error: 'order is required' }, 400);

  const spec = {
    id: { type: 'number', integer: true, min: 1 },
    displayOrder: { type: 'number', integer: true, min: 0, max: 1000 },
  } as const;
  const entries = [];
  for (const raw of order) {
    const entry = parseFields(raw, spec, ['id', 'displayOrder']);
    if (!entry.ok) return c.json({ error: entry.error }, 400);
    entries.push(entry.data);
  }

  const db = getDb(c.env.DATABASE_URL);
  await Promise.all(
    entries.map(({ id, displayOrder }) =>
      db
        .update(productImagesTable)
        .set({ displayOrder })
        .where(and(eq(productImagesTable.id, id), eq(productImagesTable.productId, productId))),
    ),
  );
  return c.json({ success: true });
});

export { images };
