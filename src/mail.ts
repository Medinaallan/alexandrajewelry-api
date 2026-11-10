// Email through SMTP (Gmail) from the Worker, with worker-mailer.
// Nodemailer needs Node sockets, which Workers don't have; worker-mailer
// speaks SMTP over Cloudflare's TCP sockets instead.
//
// The SMTP account is set in the admin panel (Configuracion > Correo) and
// stored in the `settings` table, its password encrypted. SMTP_USER /
// SMTP_PASS secrets work as a fallback. Without either, nothing is sent and
// the rest of the request works the same.

import { eq } from 'drizzle-orm';
import { getDb } from './db';
import { settingsTable } from './db/schema';
import { open } from './utils/secretBox';

export type MailEnv = {
  DATABASE_URL?: string;
  /** Also the master key that encrypts the stored SMTP password */
  JWT_SECRET?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  /** Where the store gets its notices (new orders, contact messages) */
  STORE_EMAIL?: string;
  /** Public site, for links inside the emails */
  SITE_URL?: string;
};

export type Mail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Address the recipient's "Reply" goes to */
  replyTo?: string;
};

export type SmtpConfig = { host: string; port: number; user: string; pass: string };

/** What the `settings` row with key "smtp" holds. */
export type StoredSmtp = { host: string; port: number; user: string; passSealed: string };
export const SMTP_SETTINGS_KEY = 'smtp';

const STORE_NAME = 'Alexandra Jewelry';
const DEFAULT_STORE_EMAIL = 'alexandrajewelry2@gmail.com';
const DEFAULT_SITE_URL = 'https://alexandrajewelry.vercel.app';

export const storeEmail = (env: MailEnv) => env.STORE_EMAIL || DEFAULT_STORE_EMAIL;
export const siteUrl = (env: MailEnv) => (env.SITE_URL || DEFAULT_SITE_URL).replace(/\/$/, '');

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
export const isEmail = (value: string) => EMAIL_RE.test(value) && value.length <= 200;

// The config is read at most once a minute per Worker instance
const CACHE_MS = 60_000;
let cached: { at: number; config: SmtpConfig | null } | null = null;

/** Forget the cached config (after the admin saves new settings). */
export function clearSmtpCache() {
  cached = null;
}

/** The SMTP account to send with: the admin panel's first, then the Worker secrets. */
export async function loadSmtpConfig(env: MailEnv): Promise<SmtpConfig | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.config;
  let config: SmtpConfig | null = null;
  if (env.DATABASE_URL && env.JWT_SECRET) {
    try {
      const [row] = await getDb(env.DATABASE_URL)
        .select()
        .from(settingsTable)
        .where(eq(settingsTable.key, SMTP_SETTINGS_KEY));
      const stored = row?.value as StoredSmtp | undefined;
      const pass = stored?.passSealed ? await open(env.JWT_SECRET, stored.passSealed) : null;
      if (stored?.user && pass) config = { host: stored.host, port: stored.port, user: stored.user, pass };
    } catch (err) {
      console.error('Could not read the email settings', err);
    }
  }
  if (!config && env.SMTP_USER && env.SMTP_PASS) {
    config = {
      host: env.SMTP_HOST || 'smtp.gmail.com',
      port: Number(env.SMTP_PORT || 465),
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    };
  }
  cached = { at: Date.now(), config };
  return config;
}

/** Sends with the given account. Throws on any SMTP error (used by the test button). */
export async function deliver(config: SmtpConfig, mail: Mail): Promise<void> {
  // Loaded on demand: it imports `cloudflare:sockets`, which only exists in Workers
  const { WorkerMailer } = await import('worker-mailer');
  await WorkerMailer.send(
    {
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      startTls: config.port !== 465,
      credentials: { username: config.user, password: config.pass },
      authType: 'plain',
    },
    {
      from: { name: STORE_NAME, email: config.user },
      to: mail.to,
      reply: mail.replyTo,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    },
  );
}

/** Sends one email. Never throws: a failed email must not fail the request. */
export async function sendMail(env: MailEnv, mail: Mail): Promise<boolean> {
  if (!isEmail(mail.to)) return false;
  const config = await loadSmtpConfig(env);
  if (!config) return false;
  try {
    await deliver(config, mail);
    return true;
  } catch (err) {
    console.error('Email failed:', mail.subject, err);
    return false;
  }
}

/**
 * Runs `work` after the response when the runtime allows it (Workers'
 * waitUntil), so emails don't slow the customer down. Elsewhere it awaits.
 */
export async function inBackground(ctx: { waitUntil(p: Promise<unknown>): void } | undefined, work: Promise<unknown>) {
  if (ctx) ctx.waitUntil(work);
  else await work;
}

/** The execution context of a Hono request, if there is one (tests have none). */
export function executionCtx(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }) {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

// ─── Templates ────────────────────────────────────────────────────────────────

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const money = (n: number) => `$${Number(n).toFixed(2)}`;

type Line = { name: string; quantity: number; subtotal: number };

function itemsTable(items: Line[], total: number): string {
  const rows = items
    .map(
      (i) =>
        `<tr><td style="padding:6px 0">${escapeHtml(i.quantity)} × ${escapeHtml(i.name)}</td>` +
        `<td style="padding:6px 0;text-align:right">${money(i.subtotal)}</td></tr>`,
    )
    .join('');
  return (
    `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0">${rows}` +
    `<tr><td style="padding:10px 0;border-top:1px solid #ddd;font-weight:bold">Total</td>` +
    `<td style="padding:10px 0;border-top:1px solid #ddd;text-align:right;font-weight:bold">${money(total)}</td></tr></table>`
  );
}

const itemsText = (items: Line[], total: number) =>
  [...items.map((i) => `- ${i.quantity} x ${i.name}: ${money(i.subtotal)}`), `Total: ${money(total)}`].join('\n');

/** Wraps the body in the store's simple layout. `body` must already be escaped. */
function layout(title: string, body: string): string {
  return `<!doctype html><html lang="es"><body style="margin:0;background:#f6f4ef;font-family:Georgia,'Times New Roman',serif;color:#1a1a1a">
<div style="max-width:560px;margin:0 auto;padding:32px 20px">
<div style="text-align:center;letter-spacing:4px;font-size:20px;margin-bottom:4px">ALEXANDRA</div>
<div style="text-align:center;letter-spacing:6px;font-size:11px;color:#b08d57;margin-bottom:28px">JEWELRY</div>
<div style="background:#fff;border:1px solid #e8e2d6;padding:28px 24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6">
<h1 style="font-family:Georgia,serif;font-weight:normal;font-size:22px;margin:0 0 16px">${title}</h1>
${body}
</div>
<p style="text-align:center;font-family:Arial,sans-serif;font-size:12px;color:#888;margin-top:20px">
Alexandra Jewelry · 16 Ashland Street, North Adams, MA 01247 · 413-770-9901</p>
</div></body></html>`;
}

const button = (href: string, label: string) =>
  `<p style="margin:24px 0"><a href="${escapeHtml(href)}" style="background:#b08d57;color:#fff;text-decoration:none;padding:12px 22px;display:inline-block">${escapeHtml(label)}</a></p>`;

export type OrderForMail = {
  id: number;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  customerAddress: string;
  customerCity: string;
  notes: string;
  paymentMethod: string;
  total: number;
  items: Line[];
};

const PAYMENT_LABEL: Record<string, string> = {
  transfer: 'Transferencia',
  paypal: 'PayPal o tarjeta',
  whatsapp: 'WhatsApp',
  cash: 'Efectivo',
  googlepay: 'Google Pay',
};

const trackUrl = (env: MailEnv, id: number) => `${siteUrl(env)}/track?id=${id}`;
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? '';

/** To the customer, right after placing the order. */
export function orderReceivedMail(env: MailEnv, o: OrderForMail): Mail {
  const pay =
    o.paymentMethod === 'paypal'
      ? 'Si aún no pagaste, puedes hacerlo desde el seguimiento de tu pedido durante las próximas 24 horas.'
      : 'Te contactaremos pronto para confirmar tu pedido y el pago.';
  return {
    to: o.customerEmail,
    replyTo: storeEmail(env),
    subject: `Recibimos tu pedido #${o.id} - Alexandra Jewelry`,
    html: layout(
      `¡Gracias, ${escapeHtml(firstName(o.customerName))}!`,
      `<p>Recibimos tu pedido <strong>#${o.id}</strong>.</p>${itemsTable(o.items, o.total)}` +
        `<p>Forma de pago: ${escapeHtml(PAYMENT_LABEL[o.paymentMethod] ?? o.paymentMethod)}</p><p>${escapeHtml(pay)}</p>` +
        button(trackUrl(env, o.id), 'Ver mi pedido') +
        `<p style="font-size:13px;color:#666">Para ver tu pedido necesitas tu número de pedido y el teléfono que usaste.</p>`,
    ),
    text: `Gracias, ${firstName(o.customerName)}. Recibimos tu pedido #${o.id}.\n\n${itemsText(o.items, o.total)}\n\n${pay}\n\nSigue tu pedido: ${trackUrl(env, o.id)}`,
  };
}

/** To the store, when a new order arrives. */
export function newOrderStoreMail(env: MailEnv, o: OrderForMail): Mail {
  const details = [
    ['Cliente', o.customerName],
    ['Teléfono', o.customerPhone],
    ['Correo', o.customerEmail],
    ['Dirección', [o.customerAddress, o.customerCity].filter(Boolean).join(', ')],
    ['Pago', PAYMENT_LABEL[o.paymentMethod] ?? o.paymentMethod],
    ['Notas', o.notes],
  ].filter(([, v]) => v);
  return {
    to: storeEmail(env),
    replyTo: o.customerEmail || undefined,
    subject: `Nuevo pedido #${o.id} - ${o.customerName} - ${money(o.total)}`,
    html: layout(
      `Nuevo pedido #${o.id}`,
      details.map(([k, v]) => `<div><strong>${k}:</strong> ${escapeHtml(v)}</div>`).join('') +
        itemsTable(o.items, o.total) +
        button(`${siteUrl(env)}/admin/orders`, 'Abrir pedidos'),
    ),
    text: `Nuevo pedido #${o.id}\n${details.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${itemsText(o.items, o.total)}`,
  };
}

const STATUS_MAIL: Record<string, { subject: string; title: string; body: string }> = {
  confirmed: {
    subject: 'Confirmamos tu pedido',
    title: 'Tu pedido está confirmado',
    body: 'Confirmamos tu pedido. Si todavía no pagaste, te indicaremos cómo hacerlo.',
  },
  review: {
    subject: 'Recibimos tu pago',
    title: 'Recibimos tu pago',
    body: 'Recibimos tu pago con PayPal. Lo estamos verificando y te avisaremos cuando preparemos tu pedido.',
  },
  paid: {
    subject: 'Pago confirmado',
    title: 'Tu pago está confirmado',
    body: 'Confirmamos tu pago. Estamos preparando tu pedido.',
  },
  shipped: {
    subject: 'Tu pedido va en camino',
    title: 'Tu pedido va en camino',
    body: 'Enviamos tu pedido. Pronto lo tendrás contigo.',
  },
  delivered: {
    subject: 'Tu pedido fue entregado',
    title: '¡Tu pedido fue entregado!',
    body: 'Tu pedido fue entregado. ¡Gracias por comprar en Alexandra Jewelry!',
  },
  cancelled: {
    subject: 'Tu pedido fue cancelado',
    title: 'Tu pedido fue cancelado',
    body: 'Tu pedido fue cancelado. Si tienes dudas o quieres hacerlo de nuevo, responde a este correo.',
  },
};

/** To the customer when the order changes status (null if that status has no email). */
export function statusMail(env: MailEnv, o: OrderForMail, status: string, extra = ''): Mail | null {
  const m = STATUS_MAIL[status];
  if (!m || !o.customerEmail) return null;
  const body = extra ? `${m.body} ${extra}` : m.body;
  return {
    to: o.customerEmail,
    replyTo: storeEmail(env),
    subject: `${m.subject} - Pedido #${o.id}`,
    html: layout(
      escapeHtml(m.title),
      `<p>Hola ${escapeHtml(firstName(o.customerName))},</p><p>${escapeHtml(body)}</p>` +
        `<p>Pedido <strong>#${o.id}</strong></p>${itemsTable(o.items, o.total)}` +
        button(trackUrl(env, o.id), 'Ver mi pedido'),
    ),
    text: `Hola ${firstName(o.customerName)},\n\n${body}\n\nPedido #${o.id}\n${itemsText(o.items, o.total)}\n\nSigue tu pedido: ${trackUrl(env, o.id)}`,
  };
}

/** To the store when the customer reports a PayPal payment. */
export function paypalStoreMail(env: MailEnv, o: OrderForMail, captureId: string, amount: number, stockShort: boolean): Mail {
  const warn = stockShort
    ? 'ATENCIÓN: ya no hay stock suficiente para este pedido. Repón el stock o reembolsa el pago en PayPal.'
    : 'El stock ya quedó apartado. Verifica el pago en PayPal y marca el pedido como Pagado.';
  const mismatch = Math.abs(amount - o.total) > 0.009 ? ` (el pedido es de ${money(o.total)})` : '';
  return {
    to: storeEmail(env),
    subject: `Pago PayPal pedido #${o.id} - ${money(amount)}${stockShort ? ' - SIN STOCK' : ''}`,
    html: layout(
      `Pago PayPal del pedido #${o.id}`,
      `<p>Referencia: <strong>${escapeHtml(captureId)}</strong><br>Monto reportado: <strong>${money(amount)}</strong>${escapeHtml(mismatch)}</p>` +
        `<p style="color:${stockShort ? '#c0392b' : '#333'}">${escapeHtml(warn)}</p>` +
        button(`https://www.paypal.com/activity/payment/${encodeURIComponent(captureId)}`, 'Ver en PayPal'),
    ),
    text: `Pago PayPal del pedido #${o.id}\nReferencia: ${captureId}\nMonto: ${money(amount)}${mismatch}\n${warn}`,
  };
}

/** To the store, with a message from the contact form. Replying answers the customer. */
export function contactStoreMail(env: MailEnv, m: { name: string; email: string; phone: string; message: string }): Mail {
  return {
    to: storeEmail(env),
    replyTo: m.email,
    subject: `Mensaje de contacto - ${m.name}`,
    html: layout(
      'Nuevo mensaje de contacto',
      `<div><strong>Nombre:</strong> ${escapeHtml(m.name)}</div><div><strong>Correo:</strong> ${escapeHtml(m.email)}</div>` +
        (m.phone ? `<div><strong>Teléfono:</strong> ${escapeHtml(m.phone)}</div>` : '') +
        `<p style="white-space:pre-wrap;border-left:3px solid #b08d57;padding-left:12px">${escapeHtml(m.message)}</p>` +
        `<p style="font-size:13px;color:#666">Responde a este correo para contestarle directamente.</p>`,
    ),
    text: `Nombre: ${m.name}\nCorreo: ${m.email}\nTeléfono: ${m.phone}\n\n${m.message}`,
  };
}

/** Sent from the settings page to check the account works. */
export function testMail(env: MailEnv, to: string): Mail {
  return {
    to,
    replyTo: storeEmail(env),
    subject: 'Correo de prueba - Alexandra Jewelry',
    html: layout('¡Funciona!', '<p>Este es un correo de prueba. Los avisos de pedidos y mensajes de la tienda se enviarán con esta cuenta.</p>'),
    text: 'Este es un correo de prueba. Los avisos de la tienda se enviarán con esta cuenta.',
  };
}

/** To an admin who forgot the password: one-hour link to set a new one. */
export function passwordResetMail(env: MailEnv, to: string, username: string, token: string): Mail {
  const link = `${siteUrl(env)}/admin/reset-password?token=${token}`;
  return {
    to,
    subject: 'Crea una contraseña nueva - Panel Alexandra Jewelry',
    html: layout(
      'Contraseña nueva',
      `<p>Hola ${escapeHtml(username)},</p><p>Pediste crear una contraseña nueva para el panel de la tienda. El enlace sirve una sola vez y vence en 1 hora.</p>` +
        button(link, 'Crear contraseña nueva') +
        `<p style="font-size:13px;color:#666">Si no lo pediste, ignora este correo: tu contraseña no cambia.</p>`,
    ),
    text: `Hola ${username},\n\nPara crear una contraseña nueva abre este enlace (sirve una vez y vence en 1 hora):\n${link}\n\nSi no lo pediste, ignora este correo.`,
  };
}
