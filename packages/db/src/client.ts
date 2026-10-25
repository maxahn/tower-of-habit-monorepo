import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. @tower-of-habit/db requires it to create a Postgres connection.'
  );
}

const client = postgres(connectionString);

// `casing` must match drizzle.config.ts. If they diverge, drizzle-kit creates
// e.g. password_hash while queries ask for "passwordHash" — a runtime
// "column does not exist" error that still typechecks.
export const db = drizzle(client, { schema, casing: 'snake_case' });
