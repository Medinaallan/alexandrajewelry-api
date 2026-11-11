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
  siteUrl,
  storeEmail,
  testMail,
  withStore,
  SMTP_SETTINGS_KEY,
  type MailEnv,
  type StoredSmtp,
} from '../mail';
import {
  SQUARE_SETTINGS_KEY,
  SquareApiError,
  getLocation,
  publicSquare,
  readSquareSettings,
  registerApplePayDomain,
  type SquareEnvironment,
  type StoredSquare,
} from '../square';

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
  const [paypal, square] = await Promise.all([readPaypalSettings(c.env.DATABASE_URL), readSquareSettings(c.env.DATABASE_URL)]);
  c.header('Cache-Control', 'public, max-age=60');
  return c.json({
    paypal: paypal ? { configured: true, enabled: paypal.enabled, clientId: paypal.clientId } : { configured: false },
    square: publicSquare(square),
  });
});

// Everything the public site needs: store details, bank accounts, PayPal, Square.
settings.get('/public', async (c) => {
  const [store, bankAccounts, paypal, square] = await Promise.all([
    getStoreSettings(c.env.DATABASE_URL),
    getBankAccounts(c.env.DATABASE_URL),
    readPaypalSettings(c.env.DATABASE_URL),
    readSquareSettings(c.env.DATABASE_URL),
  ]);
  const { notifyEmail: _private, ...publicStore } = store;
  c.header('Cache-Control', 'public, max-age=60');
  return c.json({
    store: publicStore,
    bankAccounts,
    paypal: paypal ? { configured: true, enabled: paypal.enabled, clientId: paypal.clientId } : { configured: false },
    square: publicSquare(square),
  });
});

// ─── Admin ───────────────────────────────────────────────────────────────────

// Everything else is for administrators only
settings.use('/mail', requireAuth, requireAdmin);
settings.use('/mail/*', requireAuth, requireAdmin);
settings.use('/paypal', requireAuth, requireAdmin);
settings.use('/square', requireAuth, requireAdmin);
settings.use('/square/*', requireAuth, requireAdmin);
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

// ─── Square: cards, Google Pay and Apple Pay ─────────────────────────────────

// Application IDs say which environment they belong to
// Production: "sq0idp-…"; Sandbox: "sandbox-sq0idb-…"
const SQUARE_APP_ID = /^(sandbox-)?sq0id[a-z]-[A-Za-z0-9_-]{10,100}$/;
const SQUARE_LOCATION_ID = /^[A-Za-z0-9]{6,40}$/;
const SQUARE_TOKEN = /^[A-Za-z0-9_-]{20,200}$/;

/** The token, if the saved one can still be decrypted. */
async function storedSquareToken(c: { env: Bindings }, s: StoredSquare | null) {
  return s?.tokenSealed ? open(c.env.JWT_SECRET, s.tokenSealed) : null;
}

settings.get('/square', async (c) => {
  const s = await readSquareSettings(c.env.DATABASE_URL);
  const token = await storedSquareToken(c, s);
  return c.json({
    configured: s !== null,
    enabled: s?.enabled ?? false,
    environment: s?.environment ?? 'production',
    applicationId: s?.applicationId ?? '',
    locationId: s?.locationId ?? '',
    locationName: s?.locationName ?? '',
    methods: s?.methods ?? { card: true, googlePay: true, applePay: true },
    hasToken: token !== null,
    // Saved, but the key changed: it has to be entered again
    tokenUnreadable: Boolean(s?.tokenSealed) && token === null,
    // What the checkout actually offers right now
    live: publicSquare(s).enabled,
  });
});

// Save Square. An empty token keeps the one already saved. The credentials
// are checked with Square before saving, so a typo shows up here and not
// when a customer tries to pay.
settings.put('/square', async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  if (typeof body.enabled !== 'boolean') return c.json({ error: 'Invalid request' }, 400);
  const environment: SquareEnvironment = body.environment === 'sandbox' ? 'sandbox' : 'production';
  const applicationId = typeof body.applicationId === 'string' ? body.applicationId.trim() : '';
  const locationId = typeof body.locationId === 'string' ? body.locationId.trim() : '';
  const newToken = typeof body.accessToken === 'string' ? body.accessToken.trim() : '';
  const rawMethods = (body.methods ?? {}) as Record<string, unknown>;
  const methods = {
    card: rawMethods.card === true,
    googlePay: rawMethods.googlePay === true,
    applePay: rawMethods.applePay === true,
  };

  if (applicationId && !SQUARE_APP_ID.test(applicationId)) {
    return c.json({ error: 'El Application ID no es válido. Empieza por «sq0idp-» (o «sandbox-sq0idb-» en pruebas).' }, 400);
  }
  if (applicationId && applicationId.startsWith('sandbox-') !== (environment === 'sandbox')) {
    return c.json({
      error: environment === 'sandbox'
        ? 'Ese Application ID es de producción. Elige «Producción» o pega el de Sandbox.'
        : 'Ese Application ID es de pruebas (Sandbox). Elige «Pruebas» o pega el de producción.',
    }, 400);
  }
  if (locationId && !SQUARE_LOCATION_ID.test(locationId)) return c.json({ error: 'El Location ID no es válido.' }, 400);
  if (newToken && !SQUARE_TOKEN.test(newToken)) return c.json({ error: 'El Access Token no es válido (cópialo completo, sin espacios).' }, 400);

  const current = await readSquareSettings(c.env.DATABASE_URL);
  // A token saved for the other environment doesn't work here
  const keepToken = !newToken && current?.environment === environment;
  const token = newToken || (keepToken ? await storedSquareToken(c, current) : null);
  const tokenSealed = newToken ? await seal(c.env.JWT_SECRET, newToken) : keepToken ? (current?.tokenSealed ?? '') : '';

  if (body.enabled) {
    if (!applicationId || !locationId) return c.json({ error: 'Completa el Application ID y el Location ID.' }, 400);
    if (!token) {
      return c.json({
        error: current?.tokenSealed && !keepToken
          ? 'Cambiaste de modo: pega el Access Token de ese modo.'
          : 'Pega el Access Token de Square.',
      }, 400);
    }
    if (!methods.card && !methods.googlePay && !methods.applePay) {
      return c.json({ error: 'Activa al menos una forma de pago: tarjeta, Google Pay o Apple Pay.' }, 400);
    }
  }

  let locationName = current?.locationId === locationId && keepToken ? current.locationName : '';
  // Check the token against the location whenever there is something to check
  if (token && locationId && (body.enabled || newToken)) {
    try {
      const location = await getLocation(environment, token, locationId);
      if (location.currency && location.currency !== 'USD') {
        return c.json({ error: `Esa ubicación de Square cobra en ${location.currency}; la tienda cobra en USD.` }, 400);
      }
      if (location.status && location.status !== 'ACTIVE') {
        return c.json({ error: 'Esa ubicación de Square está desactivada. Actívala en Square o usa otra.' }, 400);
      }
      locationName = location.name ?? '';
    } catch (err) {
      if (err instanceof SquareApiError && (err.status === 401 || err.status === 403)) {
        return c.json({
          error: `Square rechazó el Access Token. Revisa que sea el de ${environment === 'sandbox' ? 'Sandbox' : 'Producción'} y que esté completo.`,
        }, 400);
      }
      if (err instanceof SquareApiError && err.status === 404) {
        return c.json({ error: 'Square no encontró ese Location ID en la cuenta de ese Access Token.' }, 400);
      }
      console.error('Square check failed', err);
      return c.json({ error: 'No se pudo comprobar con Square. Intenta de nuevo en un momento.' }, 502);
    }
  }

  const value: StoredSquare = { enabled: body.enabled, environment, applicationId, locationId, locationName, methods, tokenSealed };
  await saveSetting(c, SQUARE_SETTINGS_KEY, value);
  return c.json({ ok: true, locationName });
});

// Forget Square (and its token): the checkout stops offering it
settings.delete('/square', async (c) => {
  await getDb(c.env.DATABASE_URL).delete(settingsTable).where(eq(settingsTable.key, SQUARE_SETTINGS_KEY));
  return c.json({ ok: true });
});

// Apple Pay only shows on domains registered with Square. The site already
// publishes Square's verification file at
// /.well-known/apple-developer-merchantid-domain-association.
settings.post('/square/apple-pay-domain', async (c) => {
  const s = await readSquareSettings(c.env.DATABASE_URL);
  const token = await storedSquareToken(c, s);
  if (!s || !token) return c.json({ error: 'Primero guarda los datos de Square.' }, 400);
  const domain = new URL(siteUrl(c.env)).hostname;
  try {
    const result = await registerApplePayDomain(s.environment, token, domain);
    return c.json({ ok: true, domain, status: result.status ?? 'VERIFIED' });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Square no pudo registrar ${domain}: ${detail}` }, 502);
  }
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
