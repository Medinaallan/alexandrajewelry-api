/**
 * Run once to initialize the database.
 * Usage: npx tsx seed.ts
 * Requires .dev.vars with DATABASE_URL set.
 */
import { config } from 'dotenv';
config({ path: '.dev.vars' });

import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { usersTable } from './src/db/schema';
import { hashPassword } from './src/utils/password';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('ERROR: DATABASE_URL not set in .dev.vars');
  process.exit(1);
}

const db = drizzle(neon(databaseUrl));

async function seed() {
  console.log('▶ Creating default admin user...');
  const passwordHash = await hashPassword('alexandra2026');
  await db
    .insert(usersTable)
    .values({
      username: 'admin',
      email: 'admin@alexandrajewelry.com',
      passwordHash,
      role: 'admin',
    })
    .onConflictDoNothing();
  console.log('  ✓ Admin user ready  (username: admin / password: alexandra2026)');
  console.log('\n✅ Seed complete!');
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});

