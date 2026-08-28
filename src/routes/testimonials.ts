import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { testimonialsTable } from '../db/schema';
import { requireAuth } from '../middleware/auth';

type Bindings = { DATABASE_URL: string; JWT_SECRET: string };

const VALID_STATUSES = ['pending', 'approved', 'rejected'] as const;
type TestimonialStatus = (typeof VALID_STATUSES)[number];

// ── Public router ─────────────────────────────────────────────────────────────

const testimonials = new Hono<{ Bindings: Bindings }>();

// GET /api/testimonials/approved — public list of approved reviews
testimonials.get('/approved', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db
    .select()
    .from(testimonialsTable)
    .where(eq(testimonialsTable.status, 'approved'))
    .orderBy(testimonialsTable.createdAt);
  return c.json(rows);
});

// POST /api/testimonials — visitor submits a new review (pending)
testimonials.post('/', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const body = await c.req.json<{
    name: string;
    text: string;
    rating?: number;
    location?: string;
    // email and productPurchased collected but not yet in DB schema
  }>();

  if (!body.name?.trim() || !body.text?.trim()) {
    return c.json({ error: 'name and text are required' }, 400);
  }

  const [row] = await db
    .insert(testimonialsTable)
    .values({
      name: body.name.trim(),
      text: body.text.trim(),
      rating: Math.min(5, Math.max(1, body.rating ?? 5)),
      location: body.location?.trim() ?? '',
      status: 'pending',
    })
    .returning();
  return c.json(row, 201);
});

// ── Admin router ──────────────────────────────────────────────────────────────

const adminTestimonials = new Hono<{ Bindings: Bindings }>();

// GET /api/admin/testimonials?status=pending|approved|rejected
adminTestimonials.get('/', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const status = c.req.query('status') as TestimonialStatus | undefined;

  const rows = status && VALID_STATUSES.includes(status)
    ? await db.select().from(testimonialsTable).where(eq(testimonialsTable.status, status)).orderBy(testimonialsTable.createdAt)
    : await db.select().from(testimonialsTable).orderBy(testimonialsTable.createdAt);

  return c.json(rows);
});

// PATCH /api/admin/testimonials/:id/status
adminTestimonials.patch('/:id/status', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const { status } = await c.req.json<{ status: string }>();

  if (!VALID_STATUSES.includes(status as TestimonialStatus)) {
    return c.json({ error: 'Invalid status' }, 400);
  }

  const [row] = await db
    .update(testimonialsTable)
    .set({ status })
    .where(eq(testimonialsTable.id, Number(c.req.param('id'))))
    .returning();
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

// DELETE /api/admin/testimonials/:id
adminTestimonials.delete('/:id', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  await db.delete(testimonialsTable).where(eq(testimonialsTable.id, Number(c.req.param('id'))));
  return c.json({ success: true });
});

export { testimonials, adminTestimonials };

