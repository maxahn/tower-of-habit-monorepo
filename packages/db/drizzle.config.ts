import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';

// Host-run tooling only (generate / migrate / studio). ENV_FILE picks which
// env file to load, same convention as the root package.json docker-compose
// scripts (defaults to .env.dev for migrate:dev). In CI/deploy, DATABASE_URL
// is injected directly into the process env and no matching file exists, so
// this is a no-op.
const envFile = process.env.ENV_FILE ?? '.env.dev';
const envPath = resolve(process.cwd(), '../../', envFile);
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env.dev at the repo root ' +
      'and fill it in, or export DATABASE_URL before running drizzle-kit.'
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  // Derives snake_case column names from camelCase schema keys. Must match the
  // `casing` passed to drizzle() in src/client.ts — this one only governs the
  // DDL that `generate` emits, the other governs the SQL queries reference.
  casing: 'snake_case',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  strict: true,
  verbose: true,
});
