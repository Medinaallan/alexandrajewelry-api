import { createMiddleware } from 'hono/factory';
import { jwtVerify } from 'jose';

type Bindings = { JWT_SECRET: string };
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
      c.set('userId', payload.sub as string);
      c.set('role', payload.role as string);
      c.set('username', payload.username as string);
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
