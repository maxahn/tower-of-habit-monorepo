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

/**
 * What a service's first argument accepts: the pooled handle above, or an open
 * transaction.
 *
 * `typeof db` ALONE IS NOT ENOUGH, and the difference is not cosmetic. A
 * transaction object is structurally missing `$client`, so a service typed
 * `typeof db` cannot be called inside db.transaction(...) at all. That is fine
 * for a service that opens its own transaction internally and never hands `tx`
 * onward (habits.ts, blocks.ts), which is why nothing needed this sooner. It is
 * NOT fine for a service the caller must be able to enrol in a transaction it
 * already owns: the evaluator writes the period transition, the tower counters,
 * the base block and the notification rows together, and ensureNotification's
 * whole reason for existing is that it composes inside that transaction.
 *
 * Derived from db.transaction's own callback rather than importing
 * PgTransaction and restating its three generics, so it cannot drift from the
 * schema or the driver.
 */
export type Db = typeof db | Parameters<Parameters<(typeof db)['transaction']>[0]>[0];
