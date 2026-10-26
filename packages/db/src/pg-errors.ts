// Postgres error classification. Drizzle wraps driver errors, so the code and
// constraint name live on `.cause`; unwrapping it belongs in one place.

export type PgError = {
  code?: string;
  constraint_name?: string;
  column_name?: string;
};

/** The driver error behind a drizzle wrapper, or the error itself if unwrapped. */
export function asPgError(e: unknown): PgError {
  return ((e as { cause?: unknown }).cause ?? e) as PgError;
}

/** 23505, unique_violation. */
export const UNIQUE_VIOLATION = '23505';

/**
 * Name-checked on purpose. A bare `code === '23505'` test would also swallow
 * entries_client_entry_id_unique — and any index added later — and report it as
 * "already logged today".
 */
export function isUniqueViolation(e: unknown, constraintName: string): boolean {
  const pg = asPgError(e);
  return pg.code === UNIQUE_VIOLATION && pg.constraint_name === constraintName;
}
