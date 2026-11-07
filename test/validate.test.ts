import { describe, expect, it } from 'vitest';
import { parseFields, parseId, safeFilename, toMoney } from '../src/utils/validate';

const spec = {
  name: { type: 'string', min: 1, max: 10 },
  price: { type: 'number', min: 0 },
  cost: { type: 'number', min: 0, nullable: true },
  stock: { type: 'number', integer: true, min: 0 },
  active: { type: 'boolean' },
} as const;

describe('parseFields', () => {
  it('keeps declared fields and drops everything else', () => {
    const result = parseFields(
      { name: '  Anillo ', price: 10, cost: null, active: true, id: 99, passwordHash: 'x' },
      spec,
      ['name'],
    );
    expect(result).toEqual({ ok: true, data: { name: 'Anillo', price: 10, cost: null, active: true } });
  });

  it.each([
    [{ price: 5 }, 'name is required'],
    [{ name: '   ' }, 'name is required'],
    [{ name: 'x'.repeat(11) }, 'name is too long'],
    [{ name: 'a', price: -1 }, 'price must be at least 0'],
    [{ name: 'a', price: '10' }, 'price must be a number'],
    [{ name: 'a', price: Number.NaN }, 'price must be a number'],
    [{ name: 'a', price: null }, 'price must be a number'],
    [{ name: 'a', stock: 1.5 }, 'stock must be a whole number'],
    [{ name: 'a', active: 'yes' }, 'active must be true or false'],
  ])('rejects %j', (body, error) => {
    expect(parseFields(body, spec, ['name'])).toEqual({ ok: false, error });
  });

  it.each([null, 'text', 5, [1, 2]])('rejects a non-object body: %j', (body) => {
    expect(parseFields(body, spec).ok).toBe(false);
  });
});

describe('parseId', () => {
  it.each([['1', 1], ['42', 42]])('accepts %s', (raw, id) => expect(parseId(raw)).toBe(id));
  it.each(['0', '-1', '1.5', 'abc', '', '1e3', ' 1', undefined])('rejects %j', (raw) =>
    expect(parseId(raw)).toBeNull(),
  );
});

describe('toMoney', () => {
  it('rounds to cents', () => {
    expect(toMoney(0.1 + 0.2)).toBe(0.3);
    expect(toMoney(1.005)).toBe(1.01);
    expect(toMoney(120.5 * 3)).toBe(361.5);
  });
});

describe('safeFilename', () => {
  it('removes path and special characters', () => {
    expect(safeFilename('../../etc/pass wd.png')).toBe('etc_pass_wd.png');
    expect(safeFilename('foto.webp')).toBe('foto.webp');
    expect(safeFilename('///')).toBe('file');
  });
});
