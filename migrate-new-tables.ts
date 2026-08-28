import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';

config({ path: '.dev.vars' });

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  await sql`
    CREATE TABLE IF NOT EXISTS "stock_products" (
      "id" serial PRIMARY KEY NOT NULL,
      "product_id" integer NOT NULL REFERENCES "products"("id"),
      "quantity" integer NOT NULL,
      "type" text DEFAULT 'entry' NOT NULL,
      "notes" text DEFAULT '' NOT NULL,
      "created_by" text DEFAULT '' NOT NULL,
      "created_at" timestamp DEFAULT now() NOT NULL
    )
  `;
  console.log('✓ stock_products table ready');

  await sql`
    CREATE TABLE IF NOT EXISTS "sales" (
      "id" serial PRIMARY KEY NOT NULL,
      "product_id" integer NOT NULL REFERENCES "products"("id"),
      "product_name" text NOT NULL,
      "quantity" integer NOT NULL,
      "unit_price" double precision NOT NULL,
      "total" double precision NOT NULL,
      "notes" text DEFAULT '' NOT NULL,
      "sold_by" text DEFAULT '' NOT NULL,
      "created_at" timestamp DEFAULT now() NOT NULL
    )
  `;
  console.log('✓ sales table ready');
}

main().catch((err) => { console.error(err); process.exit(1); });
