// Small request-validation helpers. Routes only ever write fields that are
// declared in a spec, so unknown keys in a request body are dropped.

type StringSpec = { type: 'string'; min?: number; max?: number };
type NumberSpec = { type: 'number'; min?: number; max?: number; integer?: boolean; nullable?: boolean };
type BooleanSpec = { type: 'boolean' };
export type FieldSpec = StringSpec | NumberSpec | BooleanSpec;

type FieldValue<F extends FieldSpec> = F extends StringSpec
  ? string
  : F extends NumberSpec
    ? F extends { nullable: true } ? number | null : number
    : boolean;

export type Parsed<S extends Record<string, FieldSpec>> = { [K in keyof S]?: FieldValue<S[K]> };

export type ParseResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Validates `body` against `spec`. Keys listed in `required` must be present. */
export function parseFields<S extends Record<string, FieldSpec>, R extends keyof S & string = never>(
  body: unknown,
  spec: S,
  required: readonly R[] = [],
): ParseResult<Parsed<S> & { [K in R]-?: FieldValue<S[K]> }> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Invalid request body' };
  }
  const input = body as Record<string, unknown>;
  const data: Record<string, unknown> = {};

  for (const [key, field] of Object.entries(spec)) {
    const value = input[key];
    if (value === undefined) {
      if ((required as readonly string[]).includes(key)) return { ok: false, error: `${key} is required` };
      continue;
    }
    if (field.type === 'string') {
      if (typeof value !== 'string') return { ok: false, error: `${key} must be text` };
      const text = value.trim();
      if (text.length < (field.min ?? 0)) return { ok: false, error: `${key} is required` };
      if (text.length > (field.max ?? 5000)) return { ok: false, error: `${key} is too long` };
      data[key] = text;
    } else if (field.type === 'number') {
      if (value === null && field.nullable) {
        data[key] = null;
        continue;
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, error: `${key} must be a number` };
      if (field.integer && !Number.isInteger(value)) return { ok: false, error: `${key} must be a whole number` };
      if (field.min !== undefined && value < field.min) return { ok: false, error: `${key} must be at least ${field.min}` };
      if (field.max !== undefined && value > field.max) return { ok: false, error: `${key} must be at most ${field.max}` };
      data[key] = value;
    } else {
      if (typeof value !== 'boolean') return { ok: false, error: `${key} must be true or false` };
      data[key] = value;
    }
  }
  return { ok: true, data: data as Parsed<S> & { [K in R]-?: FieldValue<S[K]> } };
}

/** Parses a numeric route param; returns null unless it is a positive integer. */
export function parseId(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Rounds to 2 decimals so money sums don't accumulate float noise. */
export function toMoney(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/** Keeps a client-supplied filename safe to use inside a storage key. */
export function safeFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^[._]+/, '');
  return cleaned.slice(-80) || 'file';
}
