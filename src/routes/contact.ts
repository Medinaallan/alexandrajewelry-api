import { Hono } from 'hono';
import { desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { contactMessagesTable } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { parseFields, parseId } from '../utils/validate';
import { contactStoreMail, executionCtx, inBackground, isEmail, sendMail, type MailEnv } from '../mail';

type Bindings = { DATABASE_URL: string; JWT_SECRET: string } & MailEnv;

const messageSpec = {
  name: { type: 'string', min: 1, max: 120 },
  email: { type: 'string', min: 1, max: 200 },
  phone: { type: 'string', max: 40 },
  message: { type: 'string', min: 1, max: 4000 },
} as const;

const contact = new Hono<{ Bindings: Bindings }>();

// Public: the contact form. Saved for the admin inbox and emailed to the store.
contact.post('/', rateLimit('PUBLIC_LIMITER'), async (c) => {
  const parsed = parseFields(await c.req.json<unknown>(), messageSpec, ['name', 'email', 'message']);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const m = { ...parsed.data, phone: parsed.data.phone ?? '' };
  if (!isEmail(m.email)) return c.json({ error: 'Escribe un correo electrónico válido.' }, 400);

  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db.insert(contactMessagesTable).values(m).returning({ id: contactMessagesTable.id });
  await inBackground(executionCtx(c), sendMail(c.env, contactStoreMail(c.env, m)));
  return c.json({ id: row.id }, 201);
});

// Admin: inbox, newest first
contact.get('/', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db.select().from(contactMessagesTable).orderBy(desc(contactMessagesTable.createdAt));
  return c.json(rows);
});

// Admin: unread count for the sidebar badge
contact.get('/unread-count', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(contactMessagesTable)
    .where(eq(contactMessagesTable.read, false));
  return c.json({ count: row?.count ?? 0 });
});

// Admin: mark as read / unread
contact.patch('/:id/read', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'));
  const { read } = await c.req.json<{ read?: unknown }>();
  if (!id || typeof read !== 'boolean') return c.json({ error: 'Invalid request' }, 400);
  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db.update(contactMessagesTable).set({ read }).where(eq(contactMessagesTable.id, id)).returning();
  return row ? c.json(row) : c.json({ error: 'Not found' }, 404);
});

contact.delete('/:id', requireAuth, async (c) => {
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Not found' }, 404);
  const db = getDb(c.env.DATABASE_URL);
  const deleted = await db.delete(contactMessagesTable).where(eq(contactMessagesTable.id, id)).returning({ id: contactMessagesTable.id });
  return deleted.length ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404);
});

export { contact };
