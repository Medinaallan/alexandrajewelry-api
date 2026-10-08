import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { usersTable } from '../db/schema';
import { verifyPassword } from '../utils/password';
import { rateLimit } from '../middleware/rateLimit';

type Bindings = { DATABASE_URL: string; JWT_SECRET: string };

const auth = new Hono<{ Bindings: Bindings }>();

auth.post('/login', rateLimit('LOGIN_LIMITER'), async (c) => {
  const { username, password } = await c.req.json<{ username?: unknown; password?: unknown }>();
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return c.json({ error: 'Missing credentials' }, 400);
  }

  const db = getDb(c.env.DATABASE_URL);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.username, username));

  if (!user || !user.active) return c.json({ error: 'Invalid credentials' }, 401);

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return c.json({ error: 'Invalid credentials' }, 401);

  const secret = new TextEncoder().encode(c.env.JWT_SECRET);
  const token = await new SignJWT({ sub: String(user.id), role: user.role, username: user.username })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret);

  return c.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

export { auth };
