Status: complete

# auth_codes Cleanup Job

## Problem Statement

Consumed and expired `auth_codes` rows accumulate indefinitely. The table is write-heavy (every login attempt creates a row) and the rows are never read after consumption or expiry. Over time this will degrade insert and index performance.

## Solution

Add a periodic worker job that deletes auth_codes rows older than a configurable retention period (default 24 hours).

## User Stories

1. As an operator, I want expired and consumed auth codes to be cleaned up automatically, so that the table doesn't grow unbounded.
2. As an operator, I want to configure how long codes are retained after expiry, so that I can balance forensic needs with table size.

## Implementation Decisions

- Add a `deleteExpiredAuthCodes(db, retentionSeconds)` function in `packages/db/src/auth/auth-codes.ts`. Deletes rows where `expiresAt + retentionSeconds < now()`. This covers both consumed and unconsumed expired codes.
- Add a `cleanup_auth_codes` task to the worker's `taskList`. Calls `deleteExpiredAuthCodes` with retention from config (default 86400 = 24 hours).
- Schedule via graphile-worker cron: run once daily. The cron spec is configured in the worker's `run` options.
- Log the count of deleted rows for observability.

## Testing Decisions

- DB-level test: insert codes with various ages and states, run delete, verify correct rows remain.
- Prior art: existing `auth-codes.test.ts` in `packages/db`.

## Out of Scope

- Cleanup of other tables (sessions, notifications, etc.). Each would be its own job if needed.
- Real-time deletion (e.g., trigger-based). Batch cleanup is sufficient.
- Partitioning the auth_codes table. Not warranted at current scale.

## Further Notes

This ticket needs further fleshing out regarding:

- Monitoring/alerting if the job fails to run or deletes an unexpected number of rows.
- Whether the retention period should differ for consumed vs. unconsumed codes (consumed codes have less forensic value).
- Whether to add an index on `expiresAt` to make the cleanup query efficient (currently only `email` is indexed). At low volume the sequential scan is fine; at high volume an index pays for itself.
- The daily cadence means at most ~24h of extra rows at any time, which is fine for the foreseeable scale.
