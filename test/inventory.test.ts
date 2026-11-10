import { beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import {
  applyStockMovement,
  registerSales,
  releaseOrderStock,
  InsufficientStockError,
  OrderChangedError,
} from '../src/db/inventory';

// In-memory Postgres with just the tables the inventory helpers touch.
const client = new PGlite();
const db = drizzle(client);

async function stockOf(id: number): Promise<number> {
  const { rows } = await client.query<{ stock: number }>('SELECT stock FROM products WHERE id = $1', [id]);
  return rows[0].stock;
}

async function count(table: 'sales' | 'stock_products'): Promise<number> {
  const { rows } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0].n;
}

beforeEach(async () => {
  await client.exec(`
    DROP TABLE IF EXISTS sales, stock_products, products, orders;
    CREATE TABLE orders (
      id serial PRIMARY KEY,
      status text NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE products (
      id serial PRIMARY KEY,
      name text NOT NULL,
      price numeric(12, 2) NOT NULL,
      cost numeric(12, 2),
      stock integer NOT NULL DEFAULT 0,
      updated_at timestamp DEFAULT now() NOT NULL
    );
    CREATE TABLE sales (
      id serial PRIMARY KEY,
      product_id integer NOT NULL REFERENCES products(id),
      product_name text NOT NULL,
      quantity integer NOT NULL,
      unit_price numeric(12, 2) NOT NULL,
      unit_cost numeric(12, 2),
      total numeric(12, 2) NOT NULL,
      notes text DEFAULT '' NOT NULL,
      sold_by text DEFAULT '' NOT NULL,
      order_id integer REFERENCES orders(id),
      created_at timestamp DEFAULT now() NOT NULL
    );
    CREATE TABLE stock_products (
      id serial PRIMARY KEY,
      product_id integer NOT NULL REFERENCES products(id),
      quantity integer NOT NULL,
      type text DEFAULT 'entry' NOT NULL,
      notes text DEFAULT '' NOT NULL,
      created_by text DEFAULT '' NOT NULL,
      created_at timestamp DEFAULT now() NOT NULL
    );
    INSERT INTO products (name, price, stock) VALUES ('Anillo', 120.50, 5), ('Collar', 80, 2);
    INSERT INTO orders (status) VALUES ('pending');
  `);
});

describe('registerSales', () => {
  it('records each line and takes the units out of stock', async () => {
    const sales = await registerSales(
      db,
      [{ productId: 1, quantity: 2 }, { productId: 2, quantity: 1, unitPrice: 70, notes: 'descuento' }],
      'ana',
    );

    expect(sales).toHaveLength(2);
    const ring = sales.find((s) => s.productId === 1)!;
    expect(ring).toMatchObject({ productName: 'Anillo', quantity: 2, unitPrice: 120.5, total: 241, soldBy: 'ana' });
    const necklace = sales.find((s) => s.productId === 2)!;
    expect(necklace).toMatchObject({ unitPrice: 70, total: 70, notes: 'descuento' });
    expect(Number.isNaN(Date.parse(ring.createdAt))).toBe(false);

    expect(await stockOf(1)).toBe(3);
    expect(await stockOf(2)).toBe(1);
  });

  it('sells nothing when one line lacks stock', async () => {
    await expect(
      registerSales(db, [{ productId: 1, quantity: 2 }, { productId: 2, quantity: 3 }], 'ana'),
    ).rejects.toBeInstanceOf(InsufficientStockError);

    expect(await stockOf(1)).toBe(5);
    expect(await stockOf(2)).toBe(2);
    expect(await count('sales')).toBe(0);
  });

  it('rejects an unknown product without touching the others', async () => {
    await expect(
      registerSales(db, [{ productId: 1, quantity: 1 }, { productId: 999, quantity: 1 }], 'ana'),
    ).rejects.toBeInstanceOf(InsufficientStockError);
    expect(await stockOf(1)).toBe(5);
    expect(await count('sales')).toBe(0);
  });

  it('never lets stock go below zero', async () => {
    await registerSales(db, [{ productId: 2, quantity: 2 }], 'ana');
    await expect(registerSales(db, [{ productId: 2, quantity: 1 }], 'ana')).rejects.toBeInstanceOf(
      InsufficientStockError,
    );
    expect(await stockOf(2)).toBe(0);
    expect(await count('sales')).toBe(1);
  });
});

describe('order stock', () => {
  const statusOf = async (id: number) =>
    (await client.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [id])).rows[0].status;
  const pay = { id: 1, from: 'pending', to: 'paid' };

  it('sells the order lines and changes its status together', async () => {
    const sales = await registerSales(db, [{ productId: 1, quantity: 2, unitPrice: 100 }], 'ana', pay);
    expect(sales[0]).toMatchObject({ orderId: 1, quantity: 2, total: 200 });
    expect(await stockOf(1)).toBe(3);
    expect(await statusOf(1)).toBe('paid');
  });

  it('keeps the status when stock is missing', async () => {
    await expect(
      registerSales(db, [{ productId: 1, quantity: 1 }, { productId: 2, quantity: 9 }], 'ana', pay),
    ).rejects.toBeInstanceOf(InsufficientStockError);
    // Also when every line is short
    await expect(registerSales(db, [{ productId: 2, quantity: 9 }], 'ana', pay)).rejects.toBeInstanceOf(
      InsufficientStockError,
    );
    expect(await statusOf(1)).toBe('pending');
    expect(await stockOf(1)).toBe(5);
    expect(await count('sales')).toBe(0);
  });

  it('does nothing if the order changed meanwhile', async () => {
    await client.query(`UPDATE orders SET status = 'cancelled'`);
    await expect(registerSales(db, [{ productId: 1, quantity: 1 }], 'ana', pay)).rejects.toBeInstanceOf(
      OrderChangedError,
    );
    expect(await stockOf(1)).toBe(5);
    expect(await count('sales')).toBe(0);
  });

  it('release puts the units back and deletes the order sales', async () => {
    await registerSales(db, [{ productId: 1, quantity: 2 }, { productId: 2, quantity: 1 }], 'ana', pay);
    await registerSales(db, [{ productId: 1, quantity: 1 }], 'ana'); // counter sale, not part of the order
    const units = await releaseOrderStock(db, { id: 1, from: 'paid', to: 'cancelled' });
    expect(units).toBe(3);
    expect(await stockOf(1)).toBe(4);
    expect(await stockOf(2)).toBe(2);
    expect(await count('sales')).toBe(1);
    expect(await statusOf(1)).toBe('cancelled');
    await expect(releaseOrderStock(db, { id: 1, from: 'paid', to: 'pending' })).rejects.toBeInstanceOf(
      OrderChangedError,
    );
  });
});

describe('applyStockMovement', () => {
  const base = { productId: 1, notes: 'nota', createdBy: 'ana' };

  it('entry adds units', async () => {
    const m = await applyStockMovement(db, { ...base, type: 'entry', quantity: 4 });
    expect(m).toMatchObject({ productId: 1, quantity: 4, type: 'entry', newStock: 9, createdBy: 'ana' });
    expect(await stockOf(1)).toBe(9);
  });

  it('return removes units and records the real change', async () => {
    const m = await applyStockMovement(db, { ...base, type: 'return', quantity: 2 });
    expect(m).toMatchObject({ quantity: -2, newStock: 3 });
  });

  it('return never drops below zero', async () => {
    const m = await applyStockMovement(db, { ...base, type: 'return', quantity: 50 });
    expect(m).toMatchObject({ quantity: -5, newStock: 0 });
    expect(await stockOf(1)).toBe(0);
  });

  it('adjustment sets the exact stock', async () => {
    const m = await applyStockMovement(db, { ...base, type: 'adjustment', quantity: 12 });
    expect(m).toMatchObject({ quantity: 7, newStock: 12 });
    expect(await stockOf(1)).toBe(12);
  });

  it('returns null for an unknown product and records nothing', async () => {
    const m = await applyStockMovement(db, { ...base, productId: 999, type: 'entry', quantity: 1 });
    expect(m).toBeNull();
    expect(await count('stock_products')).toBe(0);
  });
});
