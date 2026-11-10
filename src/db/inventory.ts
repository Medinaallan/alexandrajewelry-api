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
  /** Product cost when sold (null if the product had no cost) */
  unitCost: number | null;
  total: number;
  notes: string;
  soldBy: string;
  orderId: number | null;
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

/** Thrown when an order's status was changed by someone else meanwhile. */
export class OrderChangedError extends Error {
  constructor() {
    super('Order status changed');
  }
}

/** Moves an order from one status to another in the same statement. */
export type OrderTransition = { id: number; from: string; to: string };

/**
 * Registers every line as a sale and takes the units out of stock.
 * All-or-nothing: if any product lacks stock, nothing is sold and
 * InsufficientStockError is thrown. `lines` must not repeat a product.
 *
 * With `order`, the sales are linked to that order and its status changes
 * from `order.from` to `order.to` in the same statement. If the order is no
 * longer in `order.from`, nothing happens and OrderChangedError is thrown.
 */
export async function registerSales(
  db: SqlExecutor,
  lines: SaleLine[],
  soldBy: string,
  order?: OrderTransition,
): Promise<SaleRow[]> {
  if (lines.length === 0) return [];

  const values = sql.join(
    lines.map(
      (l) =>
        sql`(${l.productId}::int, ${l.quantity}::int, ${l.unitPrice ?? null}::numeric, ${l.notes ?? ''}::text)`,
    ),
    sql`, `,
  );

  // Without an order, `ord` is a constant row so the guards below always pass.
  const ord = order
    ? sql`UPDATE orders SET status = ${order.to}::text WHERE id = ${order.id}::int AND status = ${order.from}::text RETURNING id`
    : sql`SELECT NULL::int AS id`;

  try {
    // `upd` only touches products that still have enough stock. If that left
    // any line out, the division below hits zero and Postgres rolls back the
    // whole statement, including the stock already taken by `upd` and the
    // order status. Every line yields a row (LEFT JOIN), so the division
    // always runs.
    const { rows } = await db.execute(sql`
      WITH ord AS (${ord}),
      lines (product_id, quantity, unit_price, notes) AS (VALUES ${values}),
      upd AS (
        UPDATE products p
        SET stock = p.stock - l.quantity, updated_at = now()
        FROM lines l
        WHERE p.id = l.product_id AND p.stock >= l.quantity AND EXISTS (SELECT 1 FROM ord)
        RETURNING p.id, p.name, p.price, p.cost
      )
      INSERT INTO sales (product_id, product_name, quantity, unit_price, unit_cost, total, notes, sold_by, order_id)
      SELECT
        l.product_id,
        COALESCE(u.name, ''),
        l.quantity / (CASE WHEN (SELECT count(*) FROM upd) = (SELECT count(*) FROM lines) THEN 1 ELSE 0 END),
        COALESCE(l.unit_price, u.price::numeric, 0),
        u.cost,
        round(COALESCE(l.unit_price, u.price::numeric, 0) * l.quantity, 2),
        l.notes,
        ${soldBy}::text,
        (SELECT id FROM ord LIMIT 1)
      FROM lines l
      LEFT JOIN upd u ON u.id = l.product_id
      WHERE EXISTS (SELECT 1 FROM ord)
      RETURNING *
    `);
    if (rows.length === 0 && order) throw new OrderChangedError();
    if (rows.length !== lines.length) throw new InsufficientStockError();
    return rows.map((r) => ({
      id: Number(r.id),
      productId: Number(r.product_id),
      productName: String(r.product_name),
      quantity: Number(r.quantity),
      unitPrice: Number(r.unit_price),
      unitCost: r.unit_cost == null ? null : Number(r.unit_cost),
      total: Number(r.total),
      notes: String(r.notes),
      soldBy: String(r.sold_by),
      orderId: r.order_id == null ? null : Number(r.order_id),
      createdAt: toIso(r.created_at),
    }));
  } catch (err) {
    if ((err as { code?: string }).code === DIVISION_BY_ZERO) throw new InsufficientStockError();
    throw err;
  }
}

/**
 * Undoes what registerSales did for an order: deletes its sales, puts the
 * units back in stock and changes the order status, all in one statement.
 * Throws OrderChangedError if the order is no longer in `order.from`.
 * Returns how many units went back to stock.
 */
export async function releaseOrderStock(db: SqlExecutor, order: OrderTransition): Promise<number> {
  const { rows } = await db.execute(sql`
    WITH ord AS (
      UPDATE orders SET status = ${order.to}::text
      WHERE id = ${order.id}::int AND status = ${order.from}::text
      RETURNING id
    ),
    del AS (
      DELETE FROM sales s USING ord WHERE s.order_id = ord.id
      RETURNING s.product_id, s.quantity
    ),
    back AS (
      SELECT product_id, sum(quantity)::int AS quantity FROM del GROUP BY product_id
    ),
    upd AS (
      UPDATE products p SET stock = p.stock + b.quantity, updated_at = now()
      FROM back b WHERE p.id = b.product_id
      RETURNING p.id
    )
    SELECT
      (SELECT count(*) FROM ord)::int AS changed,
      (SELECT COALESCE(sum(quantity), 0) FROM back)::int AS units
  `);
  if (Number(rows[0]?.changed) === 0) throw new OrderChangedError();
  return Number(rows[0].units);
}

export type VoidResult =
  | { ok: true; productId: number; quantity: number; newStock: number }
  | { ok: false; reason: 'not_found' | 'from_order'; orderId?: number };

/**
 * Cancels a counter sale: deletes it and puts its units back in stock, in one
 * statement. Sales that came from a web order are not touched here: they are
 * undone by moving the order out of paid/shipped/delivered.
 */
export async function voidSale(db: SqlExecutor, saleId: number): Promise<VoidResult> {
  const { rows } = await db.execute(sql`
    WITH s AS (
      SELECT id, order_id FROM sales WHERE id = ${saleId}::int
    ),
    del AS (
      DELETE FROM sales WHERE id IN (SELECT id FROM s WHERE order_id IS NULL)
      RETURNING product_id, quantity
    ),
    upd AS (
      UPDATE products p SET stock = p.stock + d.quantity, updated_at = now()
      FROM del d WHERE p.id = d.product_id
      RETURNING p.id, p.stock
    )
    SELECT
      (SELECT order_id FROM s) AS order_id,
      (SELECT product_id FROM del) AS product_id,
      (SELECT quantity FROM del) AS quantity,
      (SELECT stock FROM upd) AS new_stock
  `);
  const r = rows[0] ?? {};
  if (r.product_id != null) {
    return { ok: true, productId: Number(r.product_id), quantity: Number(r.quantity), newStock: Number(r.new_stock) };
  }
  if (r.order_id != null) return { ok: false, reason: 'from_order', orderId: Number(r.order_id) };
  return { ok: false, reason: 'not_found' };
}

/** Changes an order status when no stock is involved. */
export async function setOrderStatus(db: SqlExecutor, order: OrderTransition): Promise<void> {
  const { rows } = await db.execute(sql`
    UPDATE orders SET status = ${order.to}::text
    WHERE id = ${order.id}::int AND status = ${order.from}::text
    RETURNING id
  `);
  if (rows.length === 0) throw new OrderChangedError();
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
