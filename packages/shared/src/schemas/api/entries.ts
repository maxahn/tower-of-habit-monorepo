import { z } from 'zod';
import { ianaTimeZone, localDate, nonNegativeInt, timestamp, uuid } from './common.js';

/*
 * Entry bodies. Mirrors LogEntryInput / Entry in @tower-of-habit/db
 * (habits/entries/entries.ts).
 *
 * The client says WHAT it did, never WHEN in tower terms: loggedAt is the
 * server's request instant and local_date is derived from it. The request is
 * strict, so a client-sent loggedAt, localDate or countsTowardQuota is
 * rejected rather than silently dropped.
 */

// entries_numeric_value_finite. z.number() already rejects NaN and ±Infinity.
const NUMERIC_VALUE_LIMIT = 1_000_000_000;

export const logEntryRequestSchema = z.strictObject({
  habitId: uuid,
  tierReached: nonNegativeInt.optional(),
  numericValue: z.number().min(-NUMERIC_VALUE_LIMIT).max(NUMERIC_VALUE_LIMIT).optional(),
  // Idempotency key for flaky-signal retries.
  clientEntryId: uuid.optional(),
  // Standalone habits only: the client's zone, never its date.
  timezone: ianaTimeZone.optional(),
});
export type LogEntryRequest = z.infer<typeof logEntryRequestSchema>;

export const entryResponseSchema = z.object({
  id: uuid,
  habitId: uuid,
  localDate,
  tierReached: nonNegativeInt,
  numericValue: z.number().nullable(),
  loggedAt: timestamp,
  countsTowardQuota: z.boolean(),
  clientEntryId: uuid.nullable(),
  createdAt: timestamp,
});
export type EntryResponse = z.infer<typeof entryResponseSchema>;
