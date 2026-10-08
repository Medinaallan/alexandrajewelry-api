import { createMiddleware } from 'hono/factory';

// Cloudflare Workers Rate Limiting binding (declared in wrangler.toml).
type RateLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

type LimiterName = 'LOGIN_LIMITER' | 'PUBLIC_LIMITER';

/**
 * Limits requests per client IP using the named binding. If the binding is
 * not configured (e.g. a local run without it) requests pass through.
 */
export function rateLimit(name: LimiterName) {
  return createMiddleware<{ Bindings: Partial<Record<LimiterName, RateLimiter>> }>(async (c, next) => {
    const limiter = c.env[name];
    if (limiter) {
      const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
      const { success } = await limiter.limit({ key: ip });
      if (!success) {
        return c.json({ error: 'Demasiados intentos. Espera un minuto e intenta de nuevo.' }, 429);
      }
    }
    await next();
  });
}
