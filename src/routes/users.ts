import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { usersTable } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { hashPassword } from '../utils/password';

type Bindings = { DATABASE_URL: string; JWT_SECRET: string };

const users = new Hono<{ Bindings: Bindings }>();

// Never return passwordHash in any response
const publicFields = {
  id: usersTable.id,
  username: usersTable.username,
  email: usersTable.email,
  role: usersTable.role,
  active: usersTable.active,
  createdAt: usersTable.createdAt,
};

users.get('/', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db.select(publicFields).from(usersTable).orderBy(usersTable.username);
  return c.json(rows);
});

users.get('/:id', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db
    .select(publicFields)
    .from(usersTable)
    .where(eq(usersTable.id, Number(c.req.param('id'))));
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

users.post('/', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const body = await c.req.json<{ username: string; email: string; password: string; role?: string }>();
  if (!body.username || !body.email || !body.password) {
    return c.json({ error: 'username, email y password son requeridos' }, 400);
  }
  if (body.password.length < 8) {
    return c.json({ error: 'La contraseña debe tener al menos 8 caracteres' }, 400);
  }
  const passwordHash = await hashPassword(body.password);
  const [row] = await db
    .insert(usersTable)
    .values({ username: body.username, email: body.email, passwordHash, role: body.role ?? 'admin' })
    .returning({ id: usersTable.id, username: usersTable.username, email: usersTable.email, role: usersTable.role });
  return c.json(row, 201);
});

users.put('/:id', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ username?: string; email?: string; role?: string }>();
  const [row] = await db
    .update(usersTable)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(usersTable.id, id))
    .returning({ id: usersTable.id, username: usersTable.username, email: usersTable.email, role: usersTable.role });
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

users.patch('/:id/password', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const { password } = await c.req.json<{ password: string }>();
  if (!password || password.length < 8) {
    return c.json({ error: 'La contraseña debe tener al menos 8 caracteres' }, 400);
  }
  const passwordHash = await hashPassword(password);
  const [row] = await db
    .update(usersTable)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(usersTable.id, Number(c.req.param('id'))))
    .returning({ id: usersTable.id });
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ success: true });
});

users.patch('/:id/toggle', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const id = Number(c.req.param('id'));
  const [current] = await db
    .select({ active: usersTable.active })
    .from(usersTable)
    .where(eq(usersTable.id, id));
  if (!current) return c.json({ error: 'Not found' }, 404);
  const [row] = await db
    .update(usersTable)
    .set({ active: !current.active, updatedAt: new Date() })
    .where(eq(usersTable.id, id))
    .returning({ id: usersTable.id, active: usersTable.active });
  return c.json(row);
});

users.delete('/:id', requireAuth, async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  await db.delete(usersTable).where(eq(usersTable.id, Number(c.req.param('id'))));
  return c.json({ success: true });
});

export { users };
