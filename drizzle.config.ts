import { defineConfig } from 'drizzle-kit';
import { config } from 'dotenv';

// Wrangler stores local env vars in .dev.vars (same format as .env)
config({ path: '.dev.vars' });

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
