import { z } from 'zod';
import { isValidTimeZone } from '../../time/timezone.js';
import { ROSTER_DISPLAY_NAME_MAX } from '../roster.js';

/*
 * Field building blocks for the API schemas. Internal: the api barrel does not
 * re-export this file, so consumers only see the finished request/response
 * schemas.
 */

export const uuid = z.uuid();

/**
 * An email address, normalised on write: trimmed and lowercased before the
 * format check, so a whitespace- or case-variant input is accepted and stored
 * in one canonical form (the spec's "trim, lowercase", and nothing else — no
 * dot-stripping or plus-tag removal). Bounded at 320 to match
 * users_email_length. The server layer re-normalises defensively, so this is
 * idempotent with crypto.normalizeEmail.
 */
export const email = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .pipe(z.email().max(320));

/** YYYY-MM-DD, calendar-checked (rejects 2026-02-30). */
export const localDate = z.iso.date();

/**
 * A timestamptz as JSON carries it: ISO-8601 with an offset. A Date object is
 * rejected, so a response that skipped serialization fails loudly.
 */
export const timestamp = z.iso.datetime({ offset: true });

/** Every varchar(DISPLAY_VARCHAR_MAX) column: names, units, tier labels. */
export const displayText = z.string().min(1).max(ROSTER_DISPLAY_NAME_MAX);

export const positiveInt = z.int().min(1);
export const nonNegativeInt = z.int().min(0);

/** IANA zone, same rule as the db layer (see isValidTimeZone). */
export const ianaTimeZone = z.string().refine(isValidTimeZone, {
  message: 'Expected an IANA time zone such as "America/Edmonton"',
});
