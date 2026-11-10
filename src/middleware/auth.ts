import { createMiddleware } from 'hono/factory';
import { jwtVerify } from 'jose';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { usersTable } from '../db/schema';

type Bindings = { JWT_SECRET: string; DATABASE_URL: string };
type Variables = { userId: string; role: string; username: string };

export const requireAuth = createMiddleware<{ Bindings: Bindings; Variables: Variables }>(
  async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const token = authHeader.slice(7);
    try {
      const secret = new TextEncoder().encode(c.env.JWT_SECRET);
      const { payload } = await jwtVerify(token, secret);
      // The token is only valid while the user is active and hasn't changed
      // password since it was issued (tokenVersion goes up on both).
      const [user] = await getDb(c.env.DATABASE_URL)
        .select({ active: usersTable.active, tokenVersion: usersTable.tokenVersion, role: usersTable.role, username: usersTable.username })
        .from(usersTable)
        .where(eq(usersTable.id, Number(payload.sub)));
      if (!user || !user.active || user.tokenVersion !== Number(payload.tv ?? 0)) {
        return c.json({ error: 'Tu sesión terminó. Inicia sesión de nuevo.' }, 401);
      }
      c.set('userId', payload.sub as string);
      c.set('role', user.role);
      c.set('username', user.username);
    } catch {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
    await next();
  }
);

/** Must run after requireAuth. Only users with the `admin` role pass. */
export const requireAdmin = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'Forbidden' }, 403);
  await next();
});
