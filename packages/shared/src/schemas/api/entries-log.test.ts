import { describe, expect, it } from 'vitest';
import {
  entryListResponseSchema,
  logEntryRequestSchema,
  logEntryResponseSchema,
} from '../index.js';

/*
 * 2.16: POST /entries and GET /habits/:id/entries.
 */

const HABIT = '9b2e4c1a-0d6f-4f7e-8a3b-2c5d6e7f8a90';
const ENTRY = {
  id: 'c0ffee00-0d6f-4f7e-8a3b-2c5d6e7f8a90',
  habitId: HABIT,
  localDate: '2026-11-16',
  tierReached: 0,
  numericValue: null,
  loggedAt: '2026-11-17T02:00:00.000Z',
  countsTowardQuota: true,
  clientEntryId: null,
  createdAt: '2026-11-17T02:00:00.000Z',
};

describe('logEntryRequestSchema (2.16)', () => {
  it('accepts an optional localDate the client believes it is logging for', () => {
    expect(
      logEntryRequestSchema.safeParse({ habitId: HABIT, localDate: '2026-11-16' }).success
    ).toBe(true);
    expect(
      logEntryRequestSchema.safeParse({ habitId: HABIT, localDate: '2026-02-30' }).success
    ).toBe(false);
    expect(
      logEntryRequestSchema.safeParse({ habitId: HABIT, localDate: 'yesterday' }).success
    ).toBe(false);
  });

  it('still rejects loggedAt and countsTowardQuota from the client', () => {
    expect(
      logEntryRequestSchema.safeParse({ habitId: HABIT, loggedAt: ENTRY.loggedAt }).success
    ).toBe(false);
    expect(
      logEntryRequestSchema.safeParse({ habitId: HABIT, countsTowardQuota: true }).success
    ).toBe(false);
    expect(logEntryRequestSchema.safeParse({ habitId: HABIT, qualifies: true }).success).toBe(
      false
    );
  });
});

describe('logEntryResponseSchema', () => {
  it('carries the entry with its source, whether it qualified, and whether it was created', () => {
    const r = logEntryResponseSchema.safeParse({
      entry: { ...ENTRY, source: 'live' },
      qualifies: true,
      created: true,
    });
    expect(r.success).toBe(true);
    expect(
      logEntryResponseSchema.safeParse({
        entry: { ...ENTRY, source: 'grace' },
        qualifies: false,
        created: false,
      }).success
    ).toBe(true);
    expect(
      logEntryResponseSchema.safeParse({
        entry: { ...ENTRY, source: 'late' },
        qualifies: true,
        created: true,
      }).success
    ).toBe(false);
  });
});

describe('entryListResponseSchema', () => {
  it('lists entries', () => {
    expect(entryListResponseSchema.safeParse({ entries: [ENTRY] }).success).toBe(true);
  });
});
