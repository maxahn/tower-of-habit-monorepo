import { z } from 'zod';
import { ianaTimeZone, localDate, nonNegativeInt, timestamp, uuid } from './common.js';

/*
 * Entry bodies. Mirrors LogEntryInput / Entry in @tower-of-habit/db
 * (habits/entries/entries.ts).
 *
 * The client says WHAT it did, never WHEN in tower terms: loggedAt is the
 * server's request instant and local_date is derived from it. The request is
 * strict, so a client-sent loggedAt, countsTowardQuota or qualifies is
 * rejected rather than silently dropped.
 *
 * 2.16 / DECISIONS P7: `localDate` is the date the client BELIEVES it is
 * logging for. It is optional and validated, not trusted: it must be today in
 * the habit's zone, or yesterday while yesterday's grace window is still open;
 * anything else is 400 date_out_of_window.
 */

// entries_numeric_value_finite. z.number() already rejects NaN and ±Infinity.
const NUMERIC_VALUE_LIMIT = 1_000_000_000;

export const logEntryRequestSchema = z.strictObject({
  habitId: uuid,
  localDate: localDate.optional(),
  tierReached: nonNegativeInt.optional(),
  numericValue: z.number().min(-NUMERIC_VALUE_LIMIT).max(NUMERIC_VALUE_LIMIT).optional(),
  // Idempotency key for flaky-signal retries (D6).
  clientEntryId: uuid.optional(),
  // Standalone habits only: the client's zone, never its date.
  timezone: ianaTimeZone.optional(),
});
export type LogEntryRequest = z.infer<typeof logEntryRequestSchema>;

/** live: before the period's deadline; grace: inside the grace window. Computed, not stored. */
export const ENTRY_SOURCES = ['live', 'grace'] as const;
export type EntrySource = (typeof ENTRY_SOURCES)[number];
export const entrySourceSchema = z.enum(ENTRY_SOURCES);

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
  source: entrySourceSchema.optional(),
});
export type EntryResponse = z.infer<typeof entryResponseSchema>;

/** POST /entries: 201 when a row was created, 200 when an existing row is returned. */
export const logEntryResponseSchema = z.strictObject({
  entry: entryResponseSchema.extend({ source: entrySourceSchema }),
  /** 2.3's verdict for this entry; the credited flag is on the entry. */
  qualifies: z.boolean(),
  created: z.boolean(),
});
export type LogEntryResponse = z.infer<typeof logEntryResponseSchema>;

export const entryListResponseSchema = z.strictObject({ entries: z.array(entryResponseSchema) });
export type EntryListResponse = z.infer<typeof entryListResponseSchema>;
