import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { settingsTable } from '../db/schema';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { parseFields } from '../utils/validate';
import { seal, open } from '../utils/secretBox';
import {
  BANK_SETTINGS_KEY,
  STORE_SETTINGS_KEY,
  clearSettingsCache,
  getBankAccounts,
  getStoreSettings,
  type BankAccount,
  type StoreSettings,
} from '../storeSettings';
import {
  clearSmtpCache,
  deliver,
  isEmail,
  loadSmtpConfig,
  storeEmail,
  testMail,
  withStore,
  SMTP_SETTINGS_KEY,
  type MailEnv,
  type StoredSmtp,
} from '../mail';

type Bindings = { DATABASE_URL: string; JWT_SECRET: string } & MailEnv;
type Variables = { username: string };

const settings = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ─── Public: what the checkout needs (no secrets) ────────────────────────────

/** What the `settings` row with key "paypal" holds. The Client ID is public. */
export type PaypalSettings = { enabled: boolean; clientId: string };
export const PAYPAL_SETTINGS_KEY = 'paypal';
const PAYPAL_CLIENT_ID = /^[A-Za-z0-9_-]{20,128}$/;

/** PayPal as set in the panel, or null if it was never set (the site then uses its build setting). */
export async function readPaypalSettings(databaseUrl: string): Promise<PaypalSettings | null> {
  const [row] = await getDb(databaseUrl).select().from(settingsTable).where(eq(settingsTable.key, PAYPAL_SETTINGS_KEY));
  return (row?.value as PaypalSettings | undefined) ?? null;
}

settings.get('/public/payments', async (c) => {
  const paypal = await readPaypalSettings(c.env.DATABASE_URL);
  c.header('Cache-Control', 'public, max-age=60');
  return c.json({ paypal: paypal ? { configured: true, enabled: paypal.enabled, clientId: paypal.clientId } : { configured: false } });
});

// Everything the public site needs: store details, bank accounts, PayPal.
settings.get('/public', async (c) => {
  const [store, bankAccounts, paypal] = await Promise.all([
    getStoreSettings(c.env.DATABASE_URL),
    getBankAccounts(c.env.DATABASE_URL),
    readPaypalSettings(c.env.DATABASE_URL),
  ]);
  const { notifyEmail: _private, ...publicStore } = store;
  c.header('Cache-Control', 'public, max-age=60');
  return c.json({
    store: publicStore,
    bankAccounts,
    paypal: paypal ? { configured: true, enabled: paypal.enabled, clientId: paypal.clientId } : { configured: false },
  });
});

// ─── Admin ───────────────────────────────────────────────────────────────────

// Everything else is for administrators only
settings.use('/mail', requireAuth, requireAdmin);
settings.use('/mail/*', requireAuth, requireAdmin);
settings.use('/paypal', requireAuth, requireAdmin);
settings.use('/store', requireAuth, requireAdmin);
settings.use('/bank', requireAuth, requireAdmin);

async function saveSetting(c: { env: Bindings; get(key: 'username'): string }, key: string, value: unknown) {
  const updatedBy = c.get('username') ?? '';
  await getDb(c.env.DATABASE_URL)
    .insert(settingsTable)
    .values({ key, value, updatedBy })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedBy, updatedAt: new Date() } });
  clearSettingsCache();
}

// Mi tienda: name, address, phone, WhatsApp, emails, hours, top bar
settings.get('/store', async (c) => c.json(await getStoreSettings(c.env.DATABASE_URL)));

settings.put('/store', async (c) => {
  const parsed = parseFields(await c.req.json<unknown>(), {
    name: { type: 'string', min: 1, max: 80 },
    street: { type: 'string', max: 120 },
    cityLine: { type: 'string', max: 120 },
    phone: { type: 'string', max: 40 },
    whatsapp: { type: 'string', max: 40 },
    email: { type: 'string', max: 200 },
    notifyEmail: { type: 'string', max: 200 },
    hours: { type: 'string', max: 600 },
    topbarMessage: { type: 'string', max: 160 },
  } as const, ['name']);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const d = parsed.data;
  const value: StoreSettings = {
    name: d.name.trim(),
    street: (d.street ?? '').trim(),
    cityLine: (d.cityLine ?? '').trim(),
    phone: (d.phone ?? '').trim(),
    // WhatsApp links need the digits only; a 10-digit US number gets its +1
    whatsapp: ((w) => (w.length === 10 ? `1${w}` : w))((d.whatsapp ?? '').replace(/\D/g, '')),
    email: (d.email ?? '').trim(),
    notifyEmail: (d.notifyEmail ?? '').trim(),
    hours: (d.hours ?? '').trim(),
    topbarMessage: (d.topbarMessage ?? '').trim(),
  };
  if (value.email && !isEmail(value.email)) return c.json({ error: 'El correo de contacto no es válido.' }, 400);
  if (value.notifyEmail && !isEmail(value.notifyEmail)) return c.json({ error: 'El correo para avisos no es válido.' }, 400);
  if (value.whatsapp && value.whatsapp.length < 8) return c.json({ error: 'El número de WhatsApp está incompleto (incluye el código de país).' }, 400);
  await saveSetting(c, STORE_SETTINGS_KEY, value);
  return c.json(value);
});

// Cuentas bancarias: shown to customers who pay by transfer
settings.get('/bank', async (c) => c.json({ accounts: await getBankAccounts(c.env.DATABASE_URL) }));

settings.put('/bank', async (c) => {
  const { accounts } = await c.req.json<{ accounts?: unknown }>();
  if (!Array.isArray(accounts) || accounts.length > 10) return c.json({ error: 'Invalid request' }, 400);
  const clean: BankAccount[] = [];
  for (const [i, raw] of accounts.entries()) {
    const parsed = parseFields(raw, {
      bank: { type: 'string', min: 1, max: 80 },
      holder: { type: 'string', min: 1, max: 120 },
      number: { type: 'string', min: 1, max: 80 },
      details: { type: 'string', max: 300 },
    } as const, ['bank', 'holder', 'number']);
    if (!parsed.ok) return c.json({ error: `Cuenta ${i + 1}: completa el banco, el titular y el número de cuenta.` }, 400);
    clean.push({
      bank: parsed.data.bank.trim(),
      holder: parsed.data.holder.trim(),
      number: parsed.data.number.trim(),
      details: (parsed.data.details ?? '').trim(),
    });
  }
  await saveSetting(c, BANK_SETTINGS_KEY, { accounts: clean });
  return c.json({ accounts: clean });
});

settings.get('/paypal', async (c) => {
  const paypal = await readPaypalSettings(c.env.DATABASE_URL);
  return c.json({ configured: paypal !== null, enabled: paypal?.enabled ?? false, clientId: paypal?.clientId ?? '' });
});

settings.put('/paypal', async (c) => {
  const body = await c.req.json<{ enabled?: unknown; clientId?: unknown }>();
  if (typeof body.enabled !== 'boolean') return c.json({ error: 'Invalid request' }, 400);
  const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
  if (body.enabled && !PAYPAL_CLIENT_ID.test(clientId)) {
    return c.json({ error: 'Pega el Client ID completo de PayPal (letras, números, guiones; sin espacios).' }, 400);
  }
  if (clientId && !PAYPAL_CLIENT_ID.test(clientId)) return c.json({ error: 'El Client ID no es válido.' }, 400);
  const value: PaypalSettings = { enabled: body.enabled, clientId };
  const updatedBy = c.get('username') ?? '';
  await getDb(c.env.DATABASE_URL)
    .insert(settingsTable)
    .values({ key: PAYPAL_SETTINGS_KEY, value, updatedBy })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedBy, updatedAt: new Date() } });
  return c.json({ ok: true });
});

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
    notifyEmail: storeEmail(await withStore(c.env)),
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
    await deliver(config, testMail(await withStore(c.env), target));
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
