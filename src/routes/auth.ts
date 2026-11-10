import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { passwordResetsTable, usersTable } from '../db/schema';
import { hashPassword, verifyPassword } from '../utils/password';
import { rateLimit } from '../middleware/rateLimit';
import { executionCtx, inBackground, passwordResetMail, sendMail, type MailEnv } from '../mail';

type Bindings = { DATABASE_URL: string; JWT_SECRET: string } & MailEnv;

const RESET_TTL_MS = 60 * 60 * 1000; // the emailed link works for one hour
const MIN_PASSWORD = 8;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

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
  const token = await new SignJWT({ sub: String(user.id), role: user.role, username: user.username, tv: user.tokenVersion })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret);

  return c.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

// Forgot password: emails a one-hour link. Always answers the same, so it
// can't be used to find out which users or emails exist.
auth.post('/forgot', rateLimit('LOGIN_LIMITER'), async (c) => {
  const { login } = await c.req.json<{ login?: unknown }>().catch(() => ({ login: undefined }));
  const answer = { ok: true, message: 'Si el usuario existe, enviamos un enlace a su correo para crear una contraseña nueva.' };
  if (typeof login !== 'string' || !login.trim()) return c.json({ error: 'Escribe tu usuario o tu correo.' }, 400);

  const db = getDb(c.env.DATABASE_URL);
  const value = login.trim();
  const [user] = await db
    .select()
    .from(usersTable)
    .where(or(eq(usersTable.username, value), sql`lower(${usersTable.email}) = lower(${value})`));
  if (!user || !user.active || !user.email) return c.json(answer);

  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  await db.insert(passwordResetsTable).values({
    userId: user.id,
    tokenHash: await sha256Hex(token),
    // Computed by the database, in its own clock
    expiresAt: sql`now() + make_interval(secs => ${RESET_TTL_MS / 1000})`,
  });
  await inBackground(executionCtx(c), sendMail(c.env, passwordResetMail(c.env, user.email, user.username, token)));
  return c.json(answer);
});

// Set a new password with the emailed link. Ends every open session.
auth.post('/reset', rateLimit('LOGIN_LIMITER'), async (c) => {
  const { token, password } = await c.req.json<{ token?: unknown; password?: unknown }>().catch(() => ({ token: undefined, password: undefined }));
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) {
    return c.json({ error: 'El enlace no es válido. Pide uno nuevo.' }, 400);
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return c.json({ error: `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.` }, 400);
  }
  const db = getDb(c.env.DATABASE_URL);
  // Taking the link and marking it used is one statement: it works only once
  const [reset] = await db
    .update(passwordResetsTable)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(passwordResetsTable.tokenHash, await sha256Hex(token)),
        isNull(passwordResetsTable.usedAt),
        gt(passwordResetsTable.expiresAt, sql`now()`),
      ),
    )
    .returning({ userId: passwordResetsTable.userId });
  if (!reset) return c.json({ error: 'El enlace venció o ya se usó. Pide uno nuevo.' }, 400);

  await db
    .update(usersTable)
    .set({ passwordHash: await hashPassword(password), tokenVersion: sql`${usersTable.tokenVersion} + 1`, updatedAt: new Date() })
    .where(eq(usersTable.id, reset.userId));
  return c.json({ ok: true });
});

export { auth };
