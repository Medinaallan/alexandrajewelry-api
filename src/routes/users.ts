import { Hono } from 'hono';
import { and, eq, ne } from 'drizzle-orm';
import { getDb } from '../db';
import { usersTable } from '../db/schema';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { hashPassword } from '../utils/password';
import { parseFields, parseId } from '../utils/validate';

type Bindings = { DATABASE_URL: string; JWT_SECRET: string };
type Variables = { userId: string; role: string; username: string };

const users = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Managing users is only for admins
users.use('*', requireAuth, requireAdmin);

const ROLES = ['admin'];

const userSpec = {
  username: { type: 'string', min: 1, max: 60 },
  email: { type: 'string', min: 3, max: 200 },
  role: { type: 'string', min: 1, max: 20 },
} as const;

// Never return passwordHash in any response
const publicFields = {
  id: usersTable.id,
  username: usersTable.username,
  email: usersTable.email,
  role: usersTable.role,
  active: usersTable.active,
  createdAt: usersTable.createdAt,
};

/** True if some active admin other than `id` exists. */
async function hasOtherActiveAdmin(db: ReturnType<typeof getDb>, id: number): Promise<boolean> {
  const [other] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(ne(usersTable.id, id), eq(usersTable.role, 'admin'), eq(usersTable.active, true)))
    .limit(1);
  return Boolean(other);
}

users.get('/', async (c) => {
  const db = getDb(c.env.DATABASE_URL);
  const rows = await db.select(publicFields).from(usersTable).orderBy(usersTable.username);
  return c.json(rows);
});

users.get('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Not found' }, 404);
  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db.select(publicFields).from(usersTable).where(eq(usersTable.id, id));
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

users.post('/', async (c) => {
  const body = await c.req.json<{ password?: unknown }>();
  const parsed = parseFields(body, userSpec, ['username', 'email']);
  if (!parsed.ok || typeof body.password !== 'string') {
    return c.json({ error: 'username, email y password son requeridos' }, 400);
  }
  if (body.password.length < 8) {
    return c.json({ error: 'La contraseña debe tener al menos 8 caracteres' }, 400);
  }
  const { username, email, role = 'admin' } = parsed.data;
  if (!ROLES.includes(role)) return c.json({ error: 'Invalid role' }, 400);

  const db = getDb(c.env.DATABASE_URL);
  const passwordHash = await hashPassword(body.password);
  const [row] = await db
    .insert(usersTable)
    .values({ username, email, passwordHash, role })
    .returning({ id: usersTable.id, username: usersTable.username, email: usersTable.email, role: usersTable.role });
  return c.json(row, 201);
});

users.put('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Not found' }, 404);
  const parsed = parseFields(await c.req.json<unknown>(), userSpec);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const data = parsed.data;
  if (data.role !== undefined && !ROLES.includes(data.role)) return c.json({ error: 'Invalid role' }, 400);

  const db = getDb(c.env.DATABASE_URL);
  const [row] = await db
    .update(usersTable)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(usersTable.id, id))
    .returning({ id: usersTable.id, username: usersTable.username, email: usersTable.email, role: usersTable.role });
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

users.patch('/:id/password', async (c) => {
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Not found' }, 404);
  const { password } = await c.req.json<{ password?: unknown }>();
  if (typeof password !== 'string' || password.length < 8) {
    return c.json({ error: 'La contraseña debe tener al menos 8 caracteres' }, 400);
  }
  const db = getDb(c.env.DATABASE_URL);
  const passwordHash = await hashPassword(password);
  const [row] = await db
    .update(usersTable)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(usersTable.id, id))
    .returning({ id: usersTable.id });
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ success: true });
});

users.patch('/:id/toggle', async (c) => {
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Not found' }, 404);
  const db = getDb(c.env.DATABASE_URL);
  const [current] = await db
    .select({ active: usersTable.active })
    .from(usersTable)
    .where(eq(usersTable.id, id));
  if (!current) return c.json({ error: 'Not found' }, 404);
  if (current.active) {
    if (String(id) === c.get('userId')) return c.json({ error: 'No puedes desactivar tu propio usuario.' }, 409);
    if (!(await hasOtherActiveAdmin(db, id))) {
      return c.json({ error: 'Debe quedar al menos un administrador activo.' }, 409);
    }
  }
  const [row] = await db
    .update(usersTable)
    .set({ active: !current.active, updatedAt: new Date() })
    .where(eq(usersTable.id, id))
    .returning({ id: usersTable.id, active: usersTable.active });
  return c.json(row);
});

users.delete('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Not found' }, 404);
  if (String(id) === c.get('userId')) return c.json({ error: 'No puedes eliminar tu propio usuario.' }, 409);
  const db = getDb(c.env.DATABASE_URL);
  if (!(await hasOtherActiveAdmin(db, id))) {
    return c.json({ error: 'Debe quedar al menos un administrador activo.' }, 409);
  }
  await db.delete(usersTable).where(eq(usersTable.id, id));
  return c.json({ success: true });
});

export { users };
