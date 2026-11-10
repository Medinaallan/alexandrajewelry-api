import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { settingsTable } from '../db/schema';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { parseFields } from '../utils/validate';
import { seal, open } from '../utils/secretBox';
import {
  clearSmtpCache,
  deliver,
  isEmail,
  loadSmtpConfig,
  storeEmail,
  testMail,
  SMTP_SETTINGS_KEY,
  type MailEnv,
  type StoredSmtp,
} from '../mail';

type Bindings = { DATABASE_URL: string; JWT_SECRET: string } & MailEnv;
type Variables = { username: string };

const settings = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Store settings are for administrators only
settings.use('*', requireAuth, requireAdmin);

async function readStored(c: { env: Bindings }): Promise<{ stored: StoredSmtp | null; updatedAt: Date | null; updatedBy: string }> {
  const [row] = await getDb(c.env.DATABASE_URL).select().from(settingsTable).where(eq(settingsTable.key, SMTP_SETTINGS_KEY));
  return { stored: (row?.value as StoredSmtp | undefined) ?? null, updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedBy ?? '' };
}

// The email account, without its password
settings.get('/mail', async (c) => {
  const { stored, updatedAt, updatedBy } = await readStored(c);
  const passwordReadable = stored?.passSealed ? (await open(c.env.JWT_SECRET, stored.passSealed)) !== null : false;
  const source = stored?.user && passwordReadable ? 'panel' : c.env.SMTP_USER && c.env.SMTP_PASS ? 'worker' : 'none';
  return c.json({
    user: stored?.user ?? '',
    host: stored?.host ?? 'smtp.gmail.com',
    port: stored?.port ?? 465,
    hasPassword: passwordReadable,
    // Saved, but the key changed: it has to be entered again
    passwordUnreadable: Boolean(stored?.passSealed) && !passwordReadable,
    source,
    notifyEmail: storeEmail(c.env),
    updatedAt,
    updatedBy,
  });
});

// Save the email account. An empty password keeps the one already saved.
settings.put('/mail', async (c) => {
  const parsed = parseFields(await c.req.json<unknown>(), {
    user: { type: 'string', min: 1, max: 200 },
    password: { type: 'string', max: 200 },
    host: { type: 'string', max: 200 },
    port: { type: 'number', integer: true, min: 1, max: 65535 },
  } as const, ['user']);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const user = parsed.data.user.trim();
  if (!isEmail(user)) return c.json({ error: 'Escribe el correo completo de la cuenta (por ejemplo, tienda@gmail.com).' }, 400);
  const host = (parsed.data.host ?? '').trim() || 'smtp.gmail.com';
  if (!/^[a-z0-9.-]+$/i.test(host)) return c.json({ error: 'Servidor SMTP no válido.' }, 400);
  const port = parsed.data.port ?? 465;
  // Google shows app passwords in groups of four ("abcd efgh ijkl mnop")
  const password = (parsed.data.password ?? '').replace(/\s+/g, '');

  const { stored } = await readStored(c);
  let passSealed = stored?.passSealed ?? '';
  if (password) passSealed = await seal(c.env.JWT_SECRET, password);
  else if (!passSealed || (await open(c.env.JWT_SECRET, passSealed)) === null) {
    return c.json({ error: 'Escribe la contraseña de aplicación.' }, 400);
  }

  const value: StoredSmtp = { host, port, user, passSealed };
  const updatedBy = c.get('username') ?? '';
  await getDb(c.env.DATABASE_URL)
    .insert(settingsTable)
    .values({ key: SMTP_SETTINGS_KEY, value, updatedBy })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedBy, updatedAt: new Date() } });
  clearSmtpCache();
  return c.json({ ok: true });
});

// Remove the account from the panel (emails stop, unless the Worker has SMTP secrets)
settings.delete('/mail', async (c) => {
  await getDb(c.env.DATABASE_URL).delete(settingsTable).where(eq(settingsTable.key, SMTP_SETTINGS_KEY));
  clearSmtpCache();
  return c.json({ ok: true });
});

// Send a test email right now and report the exact SMTP error if it fails
settings.post('/mail/test', async (c) => {
  const { to } = await c.req.json<{ to?: unknown }>();
  const target = typeof to === 'string' && to.trim() ? to.trim() : storeEmail(c.env);
  if (!isEmail(target)) return c.json({ error: 'Correo de destino no válido.' }, 400);
  clearSmtpCache();
  const config = await loadSmtpConfig(c.env);
  if (!config) return c.json({ error: 'Primero guarda la cuenta de correo.' }, 400);
  try {
    await deliver(config, testMail(c.env, target));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const hint = /auth|535|534|credential|username|password/i.test(detail)
      ? ' Revisa el correo y que la contraseña sea una "contraseña de aplicación" de Google (no la contraseña normal).'
      : '';
    return c.json({ error: `No se pudo enviar: ${detail}.${hint}` }, 502);
  }
  return c.json({ ok: true, to: target });
});

export { settings };
