import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';

export function getDb(databaseUrl: string) {
  return drizzle(neon(databaseUrl));
}
