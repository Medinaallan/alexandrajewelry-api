import { sql, type SQL } from 'drizzle-orm';

// Stock changes run as ONE SQL statement each, so the stock update and the
// row that records it (sale / movement) either both happen or neither does,
// and concurrent requests can't overwrite each other's stock value.

/** The part of a drizzle database these helpers need (neon-http and pglite both fit). */
export type SqlExecutor = {
  execute(query: SQL): PromiseLike<{ rows: Record<string, unknown>[] }>;
};

export type SaleLine = { productId: number; quantity: number; unitPrice?: number; notes?: string };

export type SaleRow = {
  id: number;
  productId: number;
  productName: string;
  quantity: number;
  unitPrice: number;
  total: number;
  notes: string;
  soldBy: string;
  createdAt: string;
};

export type MovementType = 'entry' | 'adjustment' | 'return';

export type MovementRow = {
  id: number;
  productId: number;
  quantity: number;
  type: string;
  notes: string;
  createdBy: string;
  createdAt: string;
  newStock: number;
};

/** Thrown when stock ran out between the caller's check and the write. */
export class InsufficientStockError extends Error {
  constructor() {
    super('Insufficient stock');
  }
}

const DIVISION_BY_ZERO = '22012';

// `created_at` is a timestamp without time zone holding UTC; the driver may
// hand it back as a Date or as raw text like "2026-01-31 10:20:30.123".
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const text = String(value).replace(' ', 'T');
  const hasZone = /(Z|[+-]\d\d(:?\d\d)?)$/i.test(text);
  return new Date(hasZone ? text : `${text}Z`).toISOString();
}

/**
 * Registers every line as a sale and takes the units out of stock.
 * All-or-nothing: if any product lacks stock, nothing is sold and
 * InsufficientStockError is thrown. `lines` must not repeat a product.
 */
export async function registerSales(db: SqlExecutor, lines: SaleLine[], soldBy: string): Promise<SaleRow[]> {
  if (lines.length === 0) return [];

  const values = sql.join(
    lines.map(
      (l) =>
        sql`(${l.productId}::int, ${l.quantity}::int, ${l.unitPrice ?? null}::numeric, ${l.notes ?? ''}::text)`,
    ),
    sql`, `,
  );

  try {
    // `upd` only touches products that still have enough stock. If that left
    // any line out, the division below hits zero and Postgres rolls back the
    // whole statement, including the stock already taken by `upd`.
    const { rows } = await db.execute(sql`
      WITH lines (product_id, quantity, unit_price, notes) AS (VALUES ${values}),
      upd AS (
        UPDATE products p
        SET stock = p.stock - l.quantity, updated_at = now()
        FROM lines l
        WHERE p.id = l.product_id AND p.stock >= l.quantity
        RETURNING p.id, p.name, p.price
      )
      INSERT INTO sales (product_id, product_name, quantity, unit_price, total, notes, sold_by)
      SELECT
        l.product_id,
        u.name,
        l.quantity / (CASE WHEN (SELECT count(*) FROM upd) = (SELECT count(*) FROM lines) THEN 1 ELSE 0 END),
        COALESCE(l.unit_price, u.price::numeric),
        round(COALESCE(l.unit_price, u.price::numeric) * l.quantity, 2),
        l.notes,
        ${soldBy}::text
      FROM lines l
      JOIN upd u ON u.id = l.product_id
      RETURNING *
    `);
    if (rows.length !== lines.length) throw new InsufficientStockError();
    return rows.map((r) => ({
      id: Number(r.id),
      productId: Number(r.product_id),
      productName: String(r.product_name),
      quantity: Number(r.quantity),
      unitPrice: Number(r.unit_price),
      total: Number(r.total),
      notes: String(r.notes),
      soldBy: String(r.sold_by),
      createdAt: toIso(r.created_at),
    }));
  } catch (err) {
    if ((err as { code?: string }).code === DIVISION_BY_ZERO) throw new InsufficientStockError();
    throw err;
  }
}

/**
 * Applies a stock movement and records it. Returns null if the product
 * doesn't exist.
 *
 * - entry:      adds `quantity` units
 * - return:     removes `quantity` units (never below zero)
 * - adjustment: sets stock to exactly `quantity`
 *
 * The recorded movement always stores the real change applied to stock.
 */
export async function applyStockMovement(
  db: SqlExecutor,
  movement: { productId: number; quantity: number; type: MovementType; notes: string; createdBy: string },
): Promise<MovementRow | null> {
  const { productId, type, notes, createdBy } = movement;
  const quantity = Math.abs(movement.quantity);

  const { rows } = await db.execute(sql`
    WITH old AS (
      SELECT id, stock FROM products WHERE id = ${productId}::int FOR UPDATE
    ),
    upd AS (
      UPDATE products p
      SET stock = CASE ${type}::text
            WHEN 'adjustment' THEN ${quantity}::int
            WHEN 'return' THEN GREATEST(0, p.stock - ${quantity}::int)
            ELSE p.stock + ${quantity}::int
          END,
          updated_at = now()
      FROM old
      WHERE p.id = old.id
      RETURNING p.stock AS new_stock, old.stock AS old_stock
    ),
    ins AS (
      INSERT INTO stock_products (product_id, quantity, type, notes, created_by)
      SELECT ${productId}::int, upd.new_stock - upd.old_stock, ${type}::text, ${notes}::text, ${createdBy}::text
      FROM upd
      RETURNING *
    )
    SELECT ins.*, upd.new_stock FROM ins, upd
  `);

  const r = rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    productId: Number(r.product_id),
    quantity: Number(r.quantity),
    type: String(r.type),
    notes: String(r.notes),
    createdBy: String(r.created_by),
    createdAt: toIso(r.created_at),
    newStock: Number(r.new_stock),
  };
}
