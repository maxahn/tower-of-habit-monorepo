import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';

// Host-run tooling only (generate / migrate / studio). ENV_FILE picks which
// env file to load, same convention as the root package.json docker-compose
// scripts (defaults to .env.local for migrate:dev). In CI/deploy, DATABASE_URL
// is injected directly into the process env and no matching file exists, so
// this is a no-op.
const envFile = process.env.ENV_FILE ?? '.env.local';
const envPath = resolve(process.cwd(), '../../', envFile);
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env.local at the repo root ' +
      'and fill it in, or export DATABASE_URL before running drizzle-kit.'
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  strict: true,
  verbose: true,
});
