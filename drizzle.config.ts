import { defineConfig } from 'drizzle-kit';

// drizzle-kit runs outside the app process, so it reads DATABASE_URL directly
// rather than importing the Zod-validated config (which demands BOT_TOKEN etc.).
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is required to run drizzle-kit (e.g. `pnpm db:push`).');
}

export default defineConfig({
  schema: './packages/db/src/schema.ts',
  out: './packages/db/drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  casing: 'snake_case',
  verbose: true,
  strict: true,
});
