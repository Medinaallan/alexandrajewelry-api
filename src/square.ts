// Square as the store's card processor: debit and credit cards, Google Pay and
// Apple Pay, all through the Square Web Payments SDK on the checkout page.
// The browser only turns the card (or wallet) into a one-time token; this API
// charges it with the store's Access Token, so a payment made here is real and
// confirmed: the order goes straight to "paid".
//
// Set in the admin panel (Configuración > Square) and stored in `settings`
// under the key "square". The Access Token is encrypted with secretBox.

import { eq } from 'drizzle-orm';
import { getDb } from './db';
import { settingsTable } from './db/schema';
import { open } from './utils/secretBox';

export const SQUARE_SETTINGS_KEY = 'square';
export const SQUARE_CURRENCY = 'USD';
const SQUARE_VERSION = '2025-01-23';

export type SquareEnvironment = 'production' | 'sandbox';
export type SquareMethods = { card: boolean; googlePay: boolean; applePay: boolean };

/** What the `settings` row with key "square" holds. */
export type StoredSquare = {
  enabled: boolean;
  environment: SquareEnvironment;
  /** Public: used by the payment form in the browser */
  applicationId: string;
  locationId: string;
  /** Name of the location, as Square reported it when saved (shown in the panel) */
  locationName: string;
  methods: SquareMethods;
  /** Access Token, encrypted (never sent to any browser) */
  tokenSealed: string;
};

/** What the checkout may know. */
export type PublicSquare = {
  enabled: boolean;
  environment: SquareEnvironment;
  applicationId: string;
  locationId: string;
  methods: SquareMethods;
};

export const NO_METHODS: SquareMethods = { card: false, googlePay: false, applePay: false };

export async function readSquareSettings(databaseUrl: string): Promise<StoredSquare | null> {
  const [row] = await getDb(databaseUrl).select().from(settingsTable).where(eq(settingsTable.key, SQUARE_SETTINGS_KEY));
  const value = row?.value as StoredSquare | undefined;
  return value ? { ...value, methods: { ...NO_METHODS, ...(value.methods ?? {}) } } : null;
}

const anyMethod = (m: SquareMethods) => m.card || m.googlePay || m.applePay;

/** Square as the checkout sees it: on only if it is complete and something can be paid with it. */
export function publicSquare(s: StoredSquare | null): PublicSquare {
  const on = Boolean(s && s.enabled && s.applicationId && s.locationId && s.tokenSealed && anyMethod(s.methods));
  return {
    enabled: on,
    environment: s?.environment ?? 'production',
    applicationId: on && s ? s.applicationId : '',
    locationId: on && s ? s.locationId : '',
    methods: on && s ? s.methods : NO_METHODS,
  };
}

/** Ready to charge: enabled, with a readable token. */
export async function squareForCharging(env: { DATABASE_URL: string; JWT_SECRET: string }) {
  const s = await readSquareSettings(env.DATABASE_URL);
  if (!s || !publicSquare(s).enabled) return null;
  const token = await open(env.JWT_SECRET, s.tokenSealed);
  return token ? { ...s, token } : null;
}

// ─── Square API ──────────────────────────────────────────────────────────────

const baseUrl = (environment: SquareEnvironment) =>
  environment === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';

/** Square dashboard, where the store sees its payments. */
export const dashboardUrl = (environment: SquareEnvironment) =>
  environment === 'sandbox'
    ? 'https://app.squareupsandbox.com/dashboard/sales/transactions'
    : 'https://app.squareup.com/dashboard/sales/transactions';

export type SquareError = { code?: string; detail?: string; category?: string };

export class SquareApiError extends Error {
  constructor(public status: number, public errors: SquareError[]) {
    super(errors.map((e) => e.detail || e.code).join('; ') || `Square respondió ${status}`);
  }
  get code() {
    return this.errors[0]?.code ?? '';
  }
}

async function squareFetch<T>(
  environment: SquareEnvironment,
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${baseUrl(environment)}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Square-Version': SQUARE_VERSION,
      'Content-Type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { errors?: SquareError[] };
  if (!res.ok || (data.errors && data.errors.length)) throw new SquareApiError(res.status, data.errors ?? []);
  return data;
}

export type SquareLocation = { id: string; name?: string; currency?: string; status?: string; country?: string };

export async function getLocation(environment: SquareEnvironment, token: string, locationId: string) {
  const { location } = await squareFetch<{ location: SquareLocation }>(
    environment,
    token,
    `/v2/locations/${encodeURIComponent(locationId)}`,
  );
  return location;
}

export type SquarePayment = {
  id: string;
  status: string;
  amount_money?: { amount: number; currency: string };
  receipt_url?: string;
  card_details?: { card?: { card_brand?: string; last_4?: string } };
  wallet_details?: { brand?: string };
  source_type?: string;
};

/** Charges `amount` (in dollars) to a token from the Web Payments SDK. */
export async function createPayment(
  s: { environment: SquareEnvironment; token: string; locationId: string },
  p: { sourceId: string; verificationToken?: string; amount: number; orderId: number; email?: string },
): Promise<SquarePayment> {
  const { payment } = await squareFetch<{ payment: SquarePayment }>(s.environment, s.token, '/v2/payments', {
    method: 'POST',
    body: {
      source_id: p.sourceId,
      ...(p.verificationToken ? { verification_token: p.verificationToken } : {}),
      // A new key per attempt: a declined card can be retried with another one
      idempotency_key: crypto.randomUUID(),
      amount_money: { amount: Math.round(p.amount * 100), currency: SQUARE_CURRENCY },
      location_id: s.locationId,
      autocomplete: true,
      reference_id: String(p.orderId),
      note: `Alexandra Jewelry - Pedido #${p.orderId}`,
      ...(p.email ? { buyer_email_address: p.email } : {}),
    },
  });
  return payment;
}

/** Gives the whole payment back (used when the same order got paid twice). */
export async function refundPayment(
  s: { environment: SquareEnvironment; token: string },
  payment: { id: string; amount_money?: { amount: number; currency: string } },
  reason: string,
) {
  return squareFetch(s.environment, s.token, '/v2/refunds', {
    method: 'POST',
    body: {
      idempotency_key: `refund-${payment.id}`,
      payment_id: payment.id,
      amount_money: payment.amount_money,
      reason,
    },
  });
}

/** Registers the site's domain for Apple Pay (the verification file must already be published). */
export async function registerApplePayDomain(environment: SquareEnvironment, token: string, domain: string) {
  return squareFetch<{ status?: string }>(environment, token, '/v2/apple-pay/domains', {
    method: 'POST',
    body: { domain_name: domain },
  });
}

/** How a payment was made, for the emails and the panel ("Visa •••• 4242", "Apple Pay"). */
export function describePayment(p: SquarePayment): string {
  const wallet = p.wallet_details?.brand ?? (p.source_type === 'WALLET' ? 'Billetera' : '');
  const card = p.card_details?.card;
  const brand = card?.card_brand ? card.card_brand.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase()) : '';
  const cardText = brand || card?.last_4 ? `${brand || 'Tarjeta'}${card?.last_4 ? ` •••• ${card.last_4}` : ''}` : '';
  if (wallet === 'APPLE_PAY' || p.source_type === 'APPLE_PAY') return cardText ? `Apple Pay (${cardText})` : 'Apple Pay';
  if (wallet === 'GOOGLE_PAY' || p.source_type === 'GOOGLE_PAY') return cardText ? `Google Pay (${cardText})` : 'Google Pay';
  return cardText || 'Tarjeta';
}

/** A message the customer understands for a declined payment. */
export function declineMessage(err: unknown): string {
  const code = err instanceof SquareApiError ? err.code : '';
  switch (code) {
    case 'CARD_DECLINED':
    case 'GENERIC_DECLINE':
    case 'CARD_DECLINED_CALL_ISSUER':
    case 'TRANSACTION_LIMIT':
      return 'Tu banco rechazó el pago. Prueba con otra tarjeta o comunícate con tu banco.';
    case 'INSUFFICIENT_FUNDS':
      return 'La tarjeta no tiene fondos suficientes. Prueba con otra tarjeta.';
    case 'CVV_FAILURE':
      return 'El código de seguridad (CVV) no es correcto. Revísalo e intenta de nuevo.';
    case 'ADDRESS_VERIFICATION_FAILURE':
    case 'INVALID_POSTAL_CODE':
      return 'El código postal no coincide con el de tu tarjeta. Revísalo e intenta de nuevo.';
    case 'INVALID_EXPIRATION':
    case 'EXPIRATION_FAILURE':
    case 'INVALID_EXPIRATION_DATE':
      return 'La fecha de vencimiento no es válida. Revísala e intenta de nuevo.';
    case 'INVALID_CARD':
    case 'INVALID_CARD_DATA':
    case 'INVALID_ACCOUNT':
      return 'Los datos de la tarjeta no son válidos. Revísalos e intenta de nuevo.';
    case 'CARD_NOT_SUPPORTED':
    case 'PAYMENT_METHOD_ERROR':
      return 'Esa tarjeta no se acepta. Prueba con otra.';
    case 'VERIFY_CVV_FAILURE':
    case 'VERIFY_AVS_FAILURE':
    case 'BUYER_VERIFICATION_FAILED':
      return 'Tu banco no pudo verificar el pago. Intenta de nuevo o usa otra tarjeta.';
    default:
      return 'No se pudo hacer el cobro. No se te cobró nada; intenta de nuevo o elige otra forma de pago.';
  }
}
