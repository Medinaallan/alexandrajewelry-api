// Store details and bank accounts, edited by the operator in the panel
// (Configuración > Mi tienda / Cuentas bancarias) and stored in `settings`.
// Read often (every email, the public site), so cached for a minute.

import { eq } from 'drizzle-orm';
import { getDb } from './db';
import { settingsTable } from './db/schema';

export type StoreSettings = {
  name: string;
  street: string;
  cityLine: string;
  /** Shown to customers */
  phone: string;
  /** WhatsApp number with country code, digits only (e.g. 14137709901) */
  whatsapp: string;
  /** Public contact email */
  email: string;
  /** Inbox for the store's notices (new orders, payments, messages) */
  notifyEmail: string;
  /** Opening hours, one line per row ("Lunes a viernes: 10 am - 6 pm"); empty hides them */
  hours: string;
  /** Short message on the top bar of the site; empty hides the bar */
  topbarMessage: string;
};

export type BankAccount = { bank: string; holder: string; number: string; details: string };

export const STORE_SETTINGS_KEY = 'store';
export const BANK_SETTINGS_KEY = 'bank';

export const DEFAULT_STORE: StoreSettings = {
  name: 'Alexandra Jewelry',
  street: '16 Ashland Street',
  cityLine: 'North Adams, MA 01247',
  phone: '413-770-9901',
  whatsapp: '14137709901',
  email: 'alexandrajewelry2@gmail.com',
  notifyEmail: 'alexandrajewelry2@gmail.com',
  hours: '',
  topbarMessage: '',
};

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: unknown }>();

/** Forget cached settings (after the operator saves). */
export function clearSettingsCache() {
  cache.clear();
}

async function readSetting<T>(databaseUrl: string, key: string): Promise<T | null> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T | null;
  const [row] = await getDb(databaseUrl).select().from(settingsTable).where(eq(settingsTable.key, key));
  const value = (row?.value as T | undefined) ?? null;
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** The store details: what the operator saved, completed with the defaults. */
export async function getStoreSettings(databaseUrl: string | undefined): Promise<StoreSettings> {
  if (!databaseUrl) return DEFAULT_STORE;
  try {
    const saved = await readSetting<Partial<StoreSettings>>(databaseUrl, STORE_SETTINGS_KEY);
    return { ...DEFAULT_STORE, ...(saved ?? {}) };
  } catch (err) {
    console.error('Could not read the store settings', err);
    return DEFAULT_STORE;
  }
}

export async function getBankAccounts(databaseUrl: string | undefined): Promise<BankAccount[]> {
  if (!databaseUrl) return [];
  try {
    const saved = await readSetting<{ accounts?: BankAccount[] }>(databaseUrl, BANK_SETTINGS_KEY);
    return Array.isArray(saved?.accounts) ? saved.accounts : [];
  } catch (err) {
    console.error('Could not read the bank accounts', err);
    return [];
  }
}
