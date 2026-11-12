import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  entryResponseSchema,
  logEntryRequestSchema,
  type EntryResponse,
  type LogEntryRequest,
} from '../index.js';

// Mirrors LogEntryInput / Entry (habits/entries/entries.ts).
//
// The client sends WHAT it did, never WHEN in tower terms: loggedAt is the
// server's request instant and local_date is derived from it (see the
// LogEntryInput doc comment). Both must be rejected at the boundary.

const HABIT_ID = '9b2e4c1a-0d6f-4f7e-8a3b-2c5d6e7f8a90';
const BODY = { habitId: HABIT_ID };

describe('logEntryRequestSchema', () => {
  it('accepts a bare binary log', () => {
    expect(logEntryRequestSchema.parse(BODY)).toEqual(BODY);
  });

  it('accepts every optional field', () => {
    const body = {
      habitId: HABIT_ID,
      tierReached: 2,
      numericValue: 12.5,
      clientEntryId: '5d1c9a7e-3b2f-4c6d-9e8f-0a1b2c3d4e5f',
      timezone: 'America/Edmonton',
    };
    expect(logEntryRequestSchema.parse(body)).toEqual(body);
  });

  it.each(['', 'habit-1', 42])('rejects a habitId of %p', (habitId) => {
    expect(logEntryRequestSchema.safeParse({ habitId }).success).toBe(false);
  });

  it.each([-1, 0.5, Number.NaN])('rejects a tierReached of %p', (tierReached) => {
    expect(logEntryRequestSchema.safeParse({ ...BODY, tierReached }).success).toBe(false);
  });

  // entries_numeric_value_finite: one NaN row poisons every roll-up forever.
  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1_000_000_001,
    -1_000_000_001,
    '12',
  ])('rejects a numericValue of %p', (numericValue) => {
    expect(logEntryRequestSchema.safeParse({ ...BODY, numericValue }).success).toBe(false);
  });

  it.each([1_000_000_000, -1_000_000_000, 0])('accepts a numericValue of %p', (numericValue) => {
    expect(logEntryRequestSchema.safeParse({ ...BODY, numericValue }).success).toBe(true);
  });

  it('rejects a non-uuid clientEntryId', () => {
    expect(logEntryRequestSchema.safeParse({ ...BODY, clientEntryId: 'retry-1' }).success).toBe(
      false
    );
  });

  // Postgres and Intl would both resolve some abbreviations; the db layer's
  // isValidTimeZone rejects them, and so must the boundary.
  it.each(['', 'Not/AZone', 'PST', 'GMT+25'])('rejects a timezone of %p', (timezone) => {
    expect(logEntryRequestSchema.safeParse({ ...BODY, timezone }).success).toBe(false);
  });

  it.each(['UTC', 'Europe/London', 'Asia/Kolkata'])('accepts a timezone of %p', (timezone) => {
    expect(logEntryRequestSchema.safeParse({ ...BODY, timezone }).success).toBe(true);
  });

  it.each([
    ['loggedAt', '2026-01-05T17:00:00.000Z'],
    ['localDate', '2026-01-05'],
    ['countsTowardQuota', true],
    ['id', '5d1c9a7e-3b2f-4c6d-9e8f-0a1b2c3d4e5f'],
    ['createdAt', '2026-01-05T17:00:00.000Z'],
  ])('rejects a client-supplied %s', (key, value) => {
    expect(logEntryRequestSchema.safeParse({ ...BODY, [key]: value }).success).toBe(false);
  });

  it('infers a type without server-owned fields', () => {
    expectTypeOf<LogEntryRequest>().not.toBeAny();
    expectTypeOf<LogEntryRequest>().not.toHaveProperty('loggedAt');
    expectTypeOf<LogEntryRequest>().not.toHaveProperty('localDate');
    expectTypeOf<LogEntryRequest['habitId']>().toEqualTypeOf<string>();
  });
});

describe('entryResponseSchema', () => {
  const ROW = {
    id: '5d1c9a7e-3b2f-4c6d-9e8f-0a1b2c3d4e5f',
    habitId: HABIT_ID,
    localDate: '2026-01-05',
    tierReached: 0,
    numericValue: null,
    loggedAt: '2026-01-06T01:00:00.000Z',
    countsTowardQuota: true,
    clientEntryId: null,
    createdAt: '2026-01-06T01:00:00.000Z',
  };

  it('accepts a serialized entry row', () => {
    expect(entryResponseSchema.parse(ROW)).toEqual(ROW);
  });

  it.each(['2026-1-5', '2026-01-05T00:00:00Z', '05/01/2026', '2026-02-30'])(
    'rejects a localDate of %p',
    (localDate) => {
      expect(entryResponseSchema.safeParse({ ...ROW, localDate }).success).toBe(false);
    }
  );

  it.each(['localDate', 'loggedAt', 'countsTowardQuota', 'tierReached'])('requires %s', (key) => {
    const partial: Record<string, unknown> = { ...ROW };
    delete partial[key];
    expect(entryResponseSchema.safeParse(partial).success).toBe(false);
  });

  it('infers string dates', () => {
    expectTypeOf<EntryResponse>().not.toBeAny();
    expectTypeOf<EntryResponse['localDate']>().toEqualTypeOf<string>();
    expectTypeOf<EntryResponse['loggedAt']>().toEqualTypeOf<string>();
    expectTypeOf<EntryResponse['numericValue']>().toEqualTypeOf<number | null>();
  });
});
