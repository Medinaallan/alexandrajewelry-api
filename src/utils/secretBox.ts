// Encrypts small secrets (like the SMTP password) before they go to the
// database, with AES-GCM and a key derived from the Worker's JWT_SECRET.
// Someone reading the database alone can't recover them.
// If JWT_SECRET changes, stored secrets can't be read anymore and must be
// entered again in the admin panel.

const enc = new TextEncoder();

async function deriveKey(masterSecret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(masterSecret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('alexandra-settings'), info: enc.encode('secret-box-v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

/** "v1:<base64 of iv + ciphertext>" */
export async function seal(masterSecret: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deriveKey(masterSecret), enc.encode(plain)),
  );
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv);
  out.set(cipher, iv.length);
  return `v1:${toBase64(out)}`;
}

/** The plain text, or null if it can't be decrypted (wrong key or damaged). */
export async function open(masterSecret: string, sealed: string): Promise<string | null> {
  if (!sealed.startsWith('v1:')) return null;
  try {
    const bytes = fromBase64(sealed.slice(3));
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12) },
      await deriveKey(masterSecret),
      bytes.slice(12),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
