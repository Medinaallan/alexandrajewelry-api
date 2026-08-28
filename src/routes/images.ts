import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { productImagesTable } from '../db/schema';
import { requireAuth } from '../middleware/auth';

type Bindings = { DATABASE_URL: string; JWT_SECRET: string; IMAGES: R2Bucket; R2_PUBLIC_URL: string };

const images = new Hono<{ Bindings: Bindings }>();

function dataUriToBytes(dataUri: string): { bytes: Uint8Array; contentType: string } {
  const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid data URI');
  const [, contentType, base64] = match;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, contentType };
}

// Get all images for a product
images.get('/product/:productId', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db
    .select()
    .from(productImagesTable)
    .where(eq(productImagesTable.productId, Number(c.req.param('productId'))))
    .orderBy(productImagesTable.displayOrder);
  return c.json(rows);
});

// Add image to product — body: { filename, data?, displayOrder? }
// 'data' is a base64 data URI (e.g. "data:image/webp;base64,...") — uploaded to R2, only the public URL is stored
images.post('/product/:productId', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const productId = Number(c.req.param('productId'));
  const body = await c.req.json<{ filename: string; data?: string; displayOrder?: number }>();
  if (!body.filename) return c.json({ error: 'filename is required' }, 400);

  let publicUrl: string | null = null;
  if (body.data) {
    const { bytes, contentType } = dataUriToBytes(body.data);
    const key = `products/${productId}/${crypto.randomUUID()}-${body.filename}`;
    await c.env.IMAGES.put(key, bytes, { httpMetadata: { contentType } });
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
  const db = getDb(c.env.DATABASE_URL);
  const id = Number(c.req.param('id'));
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
  const db = getDb(c.env.DATABASE_URL);
  const { order } = await c.req.json<{ order: Array<{ id: number; displayOrder: number }> }>();
  await Promise.all(
    order.map(({ id, displayOrder }) =>
      db.update(productImagesTable).set({ displayOrder }).where(eq(productImagesTable.id, id)),
    ),
  );
  return c.json({ success: true });
});

export { images };
