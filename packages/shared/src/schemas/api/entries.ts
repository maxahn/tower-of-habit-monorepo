import type { z } from 'zod';
import type { LocalDate } from '../../time/local-date.js';
import { notImplemented } from '../todo.js';

/*
 * Entry bodies. Mirrors LogEntryInput / Entry in @tower-of-habit/db
 * (habits/entries/entries.ts).
 *
 * The client says WHAT it did, never WHEN in tower terms: loggedAt is the
 * server's request instant and local_date is derived from it.
 *
 * TODO(2.1): implement, then replace the hand-written types with z.infer.
 * Rules (tests: ./entries.test.ts):
 *   - strict: loggedAt, localDate, countsTowardQuota, id, createdAt rejected;
 *   - habitId, clientEntryId: uuid;
 *   - tierReached: integer >= 0;
 *   - numericValue: finite, within ±1_000_000_000 (entries_numeric_value_finite);
 *   - timezone: same rule as isValidTimeZone in @tower-of-habit/db — "UTC" or
 *     an Area/Location name Intl accepts (rejects "PST", "Not/AZone", "");
 *     consider extracting that rule into a shared helper both packages use;
 *   - response: localDate is a real calendar YYYY-MM-DD (rejects 2026-02-30),
 *     timestamps ISO-8601 with offset, numericValue / clientEntryId nullable.
 */

export type LogEntryRequest = {
  habitId: string;
  tierReached?: number;
  numericValue?: number;
  clientEntryId?: string;
  timezone?: string;
};

export type EntryResponse = {
  id: string;
  habitId: string;
  localDate: LocalDate;
  tierReached: number;
  numericValue: number | null;
  loggedAt: string;
  countsTowardQuota: boolean;
  clientEntryId: string | null;
  createdAt: string;
};

export const logEntryRequestSchema =
  notImplemented<z.ZodType<LogEntryRequest>>('logEntryRequestSchema');
export const entryResponseSchema = notImplemented<z.ZodType<EntryResponse>>('entryResponseSchema');
