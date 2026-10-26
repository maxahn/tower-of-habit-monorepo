import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_GRACE_WINDOW_MINUTES, SOLO_DEADLINE_TIME } from '@tower-of-habit/shared';
import { db, pgError, useTestOwner } from '../../test-utils.js';
import { createMembership, transitionMembership } from '../../towers/memberships/memberships.js';
import { createTower, InvalidTimeZoneError } from '../../towers/towers.js';
import { towers } from '../../towers/schema.js';
import { createHabit, deleteHabit, HabitNotFoundError } from '../habits.js';
import {
  addSupplementalEntry,
  AlreadyLoggedError,
  dailyNumericTotal,
  deleteEntry,
  EntryShapeError,
  getEntry,
  listEntriesForDate,
  listEntriesForHabit,
  listQualifyingDates,
  logEntry,
  qualifyingEntryForDate,
  resolveLoggingContext,
} from './entries.js';
import { entries } from './schema.js';

const EDM = 'America/Edmonton';
// Edmonton is MDT (-06:00) in late October.
const AT_2330_OCT24 = new Date('2026-10-25T05:30:00Z');
const AT_0030_OCT25 = new Date('2026-10-25T06:30:00Z');
const AT_NOON_OCT25 = new Date('2026-10-25T18:00:00Z');

const owner = useTestOwner();

// Deleting the owner's towers cascades to memberships, which would otherwise
// block deleting the owner and their habits (no on-delete action). Vitest runs
// afterEach hooks in reverse registration order: this one runs first. Entries
// need no hook of their own — habit_id cascades.
afterEach(async () => {
  await db.delete(towers).where(eq(towers.hostId, owner()));
});

function tower(overrides: { deadlineTime?: string; graceWindowMinutes?: number } = {}) {
  return createTower(db, {
    hostId: owner(),
    name: 'Morning run',
    deadlineTime: '23:00',
    timezone: EDM,
    ...overrides,
  });
}

function habit(type: 'binary' | 'numeric' | 'tiered' = 'binary') {
  if (type === 'tiered') {
    return createHabit(db, {
      ownerId: owner(),
      name: 'Run',
      type: 'tiered',
      tiers: [{ tierIndex: 0, label: 'Base', thresholdValue: 1 }],
    });
  }
  return createHabit(db, {
    ownerId: owner(),
    name: 'Run',
    type,
    ...(type === 'numeric' ? { unit: 'minutes' } : {}),
  });
}

/** A habit inside a tower, i.e. the tower-time logging path. */
async function inTower(
  type: 'binary' | 'numeric' | 'tiered' = 'binary',
  overrides: { deadlineTime?: string; graceWindowMinutes?: number } = {}
) {
  const [t, h] = await Promise.all([tower(overrides), habit(type)]);
  const m = await createMembership(db, { towerId: t.id, userId: owner(), habitId: h.id });
  return { tower: t, habit: h, membership: m };
}

/** Raw insert, bypassing the service entirely. */
function rawEntry(habitId: string, localDate: string, countsTowardQuota = true, value?: number) {
  return db
    .insert(entries)
    .values({
      habitId,
      localDate,
      countsTowardQuota,
      ...(value !== undefined ? { numericValue: value } : {}),
    })
    .returning();
}

describe('entries defaults and CRUD', () => {
  it('inserts with spec defaults', async () => {
    const h = await habit();
    const [e] = await rawEntry(h.id, '2026-10-24', false);
    expect(e).toMatchObject({
      habitId: h.id,
      localDate: '2026-10-24',
      tierReached: 0,
      numericValue: null,
      countsTowardQuota: false,
      clientEntryId: null,
    });
    expect(e!.loggedAt).toBeInstanceOf(Date);
    expect(e!.createdAt).toBeInstanceOf(Date);
  });

  it('gets and lists, round-tripping local_date as a string', async () => {
    const h = await habit();
    const [e] = await rawEntry(h.id, '2026-10-24');
    expect(await getEntry(db, e!.id)).toEqual(e);
    expect(await listEntriesForHabit(db, h.id)).toEqual([e]);
    expect(await listEntriesForDate(db, h.id, '2026-10-24')).toEqual([e]);
    expect(await getEntry(db, crypto.randomUUID())).toBeUndefined();
  });

  it('deletes, and deleting a missing entry is a no-op', async () => {
    const h = await habit();
    const [e] = await rawEntry(h.id, '2026-10-24');
    await deleteEntry(db, e!.id);
    expect(await getEntry(db, e!.id)).toBeUndefined();
    await expect(deleteEntry(db, crypto.randomUUID())).resolves.toBeUndefined();
  });
});

describe('entries constraints', () => {
  it('rejects a nonexistent habit_id', async () => {
    expect(await pgError(rawEntry(crypto.randomUUID(), '2026-10-24'))).toMatchObject({
      code: '23503',
    });
  });

  it('cascades on habit delete', async () => {
    const h = await habit();
    const [e] = await rawEntry(h.id, '2026-10-24');
    await deleteHabit(db, h.id);
    expect(await getEntry(db, e!.id)).toBeUndefined();
  });

  it('rejects a negative tier_reached', async () => {
    const h = await habit('tiered');
    const e = await pgError(
      db.insert(entries).values({ habitId: h.id, localDate: '2026-10-24', tierReached: -1 })
    );
    expect(e).toMatchObject({ code: '23514', constraint_name: 'entries_tier_reached_nonnegative' });
  });

  // A single NaN row would poison every roll-up for the date forever.
  it.each(['NaN', 'Infinity', '-Infinity'])('rejects a numeric_value of %s', async (value) => {
    const h = await habit('numeric');
    const e = await pgError(
      db.execute(
        sql`insert into ${entries} (habit_id, local_date, numeric_value)
            values (${h.id}, '2026-10-24', ${value}::numeric)`
      )
    );
    expect(e).toMatchObject({ code: '23514', constraint_name: 'entries_numeric_value_finite' });
  });
});

// The §4 guarantee. These tests use RAW inserts throughout: the point is that
// the index, not the application, is what prevents a double credit.
describe('one_qualifying_entry_per_day', () => {
  it('rejects a second qualifying entry for the same day', async () => {
    const h = await habit();
    await rawEntry(h.id, '2026-10-24');
    expect(await pgError(rawEntry(h.id, '2026-10-24'))).toMatchObject({
      code: '23505',
      constraint_name: 'one_qualifying_entry_per_day',
    });
  });

  it('allows any number of non-qualifying entries for the same day', async () => {
    const h = await habit();
    await rawEntry(h.id, '2026-10-24', true);
    await rawEntry(h.id, '2026-10-24', false);
    await rawEntry(h.id, '2026-10-24', false);
    expect(await listEntriesForDate(db, h.id, '2026-10-24')).toHaveLength(3);
  });

  it('lets exactly one of five concurrent qualifying inserts win', async () => {
    const h = await habit();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => rawEntry(h.id, '2026-10-24'))
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect(await pgError(Promise.reject(r.reason))).toMatchObject({
        code: '23505',
        constraint_name: 'one_qualifying_entry_per_day',
      });
    }
    expect(await listEntriesForDate(db, h.id, '2026-10-24')).toHaveLength(1);
  });

  // Two independent connections, so the loser genuinely blocks on the index
  // rather than being serialised by the pool. Deterministic by construction: A
  // holds the key uncommitted before B is sent, B blocks on the index, A
  // commits, B is rejected. Nothing here depends on who wins a race.
  it('blocks a second connection on the uncommitted key, then rejects it', async () => {
    const h = await habit();
    const a = postgres(process.env.DATABASE_URL!, { max: 1 });
    const b = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      let held: () => void = () => {};
      let inserted: () => void = () => {};
      const release = new Promise<void>((r) => {
        held = r;
      });
      const keyIsHeld = new Promise<void>((r) => {
        inserted = r;
      });

      const txA = a.begin(async (tx) => {
        await tx`insert into entries (habit_id, local_date, counts_toward_quota)
                 values (${h.id}, '2026-10-24', true)`;
        inserted();
        await release;
      });
      await keyIsHeld;

      // Settle both ways immediately, so a rejection is never unhandled.
      const outcomeB = b`insert into entries (habit_id, local_date, counts_toward_quota)
                         values (${h.id}, '2026-10-24', true)`.then(
        () => null,
        (e: unknown) => e
      );
      // Long enough for B to reach the index and park on A's uncommitted key.
      await new Promise((r) => setTimeout(r, 150));
      held();
      await txA;

      expect(await outcomeB).toMatchObject({
        code: '23505',
        constraint_name: 'one_qualifying_entry_per_day',
      });
      expect(await listEntriesForDate(db, h.id, '2026-10-24')).toHaveLength(1);
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
  });

  it('frees the day once the qualifying entry is deleted', async () => {
    const h = await habit();
    const [first] = await rawEntry(h.id, '2026-10-24');
    await deleteEntry(db, first!.id);
    const [second] = await rawEntry(h.id, '2026-10-24');
    expect(second!.countsTowardQuota).toBe(true);
  });
});

describe('logEntry — tower path', () => {
  it('reads the tower timezone, deadline and grace window', async () => {
    const { habit: h } = await inTower('binary', { graceWindowMinutes: 120 });
    expect(await resolveLoggingContext(db, h.id, AT_0030_OCT25)).toMatchObject({
      timeZone: EDM,
      deadlineTime: '23:00:00',
      graceMinutes: 120,
      habitType: 'binary',
    });
  });

  it('fills the gap: a 00:30 log with yesterday empty credits yesterday', async () => {
    const { habit: h } = await inTower();
    const e = await logEntry(db, { habitId: h.id, loggedAt: AT_0030_OCT25 });
    expect(e).toMatchObject({ localDate: '2026-10-24', countsTowardQuota: true });
  });

  // The branch the ticket calls out: the naive "always attach to yesterday" rule
  // would trip the index here and reject a log for a day they weren't logging.
  it('never overwrites: a 00:30 log after a 20:00 log credits today, and both rows survive', async () => {
    const { habit: h } = await inTower();
    const evening = await logEntry(db, {
      habitId: h.id,
      loggedAt: new Date('2026-10-25T02:00:00Z'), // 20:00 local on the 24th
    });
    const midnight = await logEntry(db, { habitId: h.id, loggedAt: AT_0030_OCT25 });
    expect(evening.localDate).toBe('2026-10-24');
    expect(midnight.localDate).toBe('2026-10-25');
    expect(await listQualifyingDates(db, h.id, 10)).toEqual(['2026-10-25', '2026-10-24']);
  });

  it('translates a same-day double-tap into AlreadyLoggedError', async () => {
    const { habit: h } = await inTower();
    await logEntry(db, { habitId: h.id, loggedAt: AT_NOON_OCT25 });
    const err = await logEntry(db, { habitId: h.id, loggedAt: AT_NOON_OCT25 }).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(AlreadyLoggedError);
    expect(err).toMatchObject({ habitId: h.id, localDate: '2026-10-25' });
  });

  it('a grace of 0 never gap-fills, reproducing the hard cliff', async () => {
    const { habit: h } = await inTower('binary', { graceWindowMinutes: 0 });
    const e = await logEntry(db, { habitId: h.id, loggedAt: AT_0030_OCT25 });
    expect(e.localDate).toBe('2026-10-25');
  });

  it('defaults loggedAt to the server clock rather than trusting a caller', async () => {
    const { habit: h } = await inTower();
    const before = Date.now();
    const e = await logEntry(db, { habitId: h.id });
    expect(e.loggedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe('logEntry — standalone habit path', () => {
  it('uses the solo fallback: midnight boundary with the default grace', async () => {
    const h = await habit();
    expect(await resolveLoggingContext(db, h.id, AT_0030_OCT25, 'Asia/Kolkata')).toMatchObject({
      timeZone: 'Asia/Kolkata',
      deadlineTime: SOLO_DEADLINE_TIME,
      graceMinutes: DEFAULT_GRACE_WINDOW_MINUTES,
    });
  });

  it('gap-fills across the client-reported zone', async () => {
    const h = await habit();
    // 00:30 IST on the 25th is 19:00Z on the 24th.
    const e = await logEntry(db, {
      habitId: h.id,
      loggedAt: new Date('2026-10-24T19:00:00Z'),
      timezone: 'Asia/Kolkata',
    });
    expect(e.localDate).toBe('2026-10-24');
  });

  it('falls back to UTC when the client reports no zone', async () => {
    const h = await habit();
    expect(await resolveLoggingContext(db, h.id, AT_0030_OCT25)).toMatchObject({
      timeZone: 'UTC',
    });
  });

  it('rejects a bogus reported zone', async () => {
    const h = await habit();
    await expect(
      logEntry(db, { habitId: h.id, loggedAt: AT_0030_OCT25, timezone: 'PST' })
    ).rejects.toBeInstanceOf(InvalidTimeZoneError);
  });

  // one_active_tower_per_habit only counts state != 'removed', so a removed
  // membership leaves the habit solo again.
  it('returns to the solo fallback once the membership is removed', async () => {
    const { habit: h, membership: m } = await inTower();
    await transitionMembership(db, m.id, { to: 'removed' });
    expect(await resolveLoggingContext(db, h.id, AT_0030_OCT25)).toMatchObject({
      timeZone: 'UTC',
      deadlineTime: SOLO_DEADLINE_TIME,
    });
  });
});

describe('logEntry — shape validation', () => {
  it('rejects a numeric value on a binary habit', async () => {
    const h = await habit('binary');
    const err = await logEntry(db, { habitId: h.id, numericValue: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EntryShapeError);
    expect(err).toMatchObject({ reason: 'numeric_value_not_allowed' });
  });

  it('requires a numeric value on a numeric habit', async () => {
    const h = await habit('numeric');
    const err = await logEntry(db, { habitId: h.id }).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: 'numeric_value_required' });
  });

  it.each(['binary', 'numeric'] as const)('rejects a tier above 0 on a %s habit', async (type) => {
    const h = await habit(type);
    const err = await logEntry(db, {
      habitId: h.id,
      tierReached: 2,
      ...(type === 'numeric' ? { numericValue: 5 } : {}),
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: 'tier_not_allowed' });
  });

  // The measurement that determined the tier is worth keeping: thresholdValue
  // is numeric, so tier records and personal bests can read it back.
  it('accepts a numeric value on a tiered habit', async () => {
    const h = await habit('tiered');
    const e = await logEntry(db, { habitId: h.id, tierReached: 1, numericValue: 42 });
    expect(e).toMatchObject({ tierReached: 1, numericValue: 42 });
  });

  it('throws HabitNotFoundError for a missing habit', async () => {
    await expect(logEntry(db, { habitId: crypto.randomUUID() })).rejects.toBeInstanceOf(
      HabitNotFoundError
    );
  });
});

describe('numeric roll-up (§4)', () => {
  it('sums every row for the date but credits only the first', async () => {
    const { habit: h } = await inTower('numeric');
    await logEntry(db, { habitId: h.id, loggedAt: AT_NOON_OCT25, numericValue: 30 });
    await addSupplementalEntry(db, {
      habitId: h.id,
      loggedAt: AT_NOON_OCT25,
      numericValue: 20,
    });
    await addSupplementalEntry(db, {
      habitId: h.id,
      loggedAt: AT_NOON_OCT25,
      numericValue: 12.5,
    });
    expect(await dailyNumericTotal(db, h.id, '2026-10-25')).toBe(62.5);
    const rows = await listEntriesForDate(db, h.id, '2026-10-25');
    expect(rows.filter((r) => r.countsTowardQuota)).toHaveLength(1);
    expect(rows).toHaveLength(3);
  });

  it('reads 0 for a date with no entries', async () => {
    const h = await habit('numeric');
    expect(await dailyNumericTotal(db, h.id, '2026-10-25')).toBe(0);
  });

  // The regression test for the mirror-image resolver: a credit before midnight
  // and a supplemental after it must land on ONE date, or the SUM undercounts
  // that date and the orphan inflates the next.
  it('keeps a 23:30 credit and a 00:30 supplemental on the same date', async () => {
    const { habit: h } = await inTower('numeric');
    const credited = await logEntry(db, {
      habitId: h.id,
      loggedAt: AT_2330_OCT24,
      numericValue: 30,
    });
    const supplemental = await addSupplementalEntry(db, {
      habitId: h.id,
      loggedAt: AT_0030_OCT25,
      numericValue: 20,
    });
    expect(credited.localDate).toBe('2026-10-24');
    expect(supplemental.localDate).toBe('2026-10-24');
    expect(await dailyNumericTotal(db, h.id, '2026-10-24')).toBe(50);
    expect(await dailyNumericTotal(db, h.id, '2026-10-25')).toBe(0);
  });

  it('exposes the credited row on its own', async () => {
    const { habit: h } = await inTower();
    const e = await logEntry(db, { habitId: h.id, loggedAt: AT_NOON_OCT25 });
    expect(await qualifyingEntryForDate(db, h.id, '2026-10-25')).toMatchObject({ id: e.id });
    expect(await qualifyingEntryForDate(db, h.id, '2026-10-24')).toBeUndefined();
  });
});

describe('logEntry — idempotency (5.15)', () => {
  it('returns the original row when a retry resends the key', async () => {
    const { habit: h } = await inTower();
    const key = crypto.randomUUID();
    const first = await logEntry(db, {
      habitId: h.id,
      loggedAt: AT_NOON_OCT25,
      clientEntryId: key,
    });
    const retry = await logEntry(db, {
      habitId: h.id,
      loggedAt: AT_NOON_OCT25,
      clientEntryId: key,
    });
    expect(retry.id).toBe(first.id);
    expect(await listEntriesForHabit(db, h.id)).toHaveLength(1);
  });

  // The case the partial index structurally cannot catch: the first attempt
  // gap-filled yesterday, so the retry resolves to TODAY and its key is the only
  // thing standing between one tap and two credits on two different dates.
  it('catches a retry that resolved to a different date', async () => {
    const { habit: h } = await inTower();
    const key = crypto.randomUUID();
    const first = await logEntry(db, {
      habitId: h.id,
      loggedAt: AT_0030_OCT25,
      clientEntryId: key,
    });
    expect(first.localDate).toBe('2026-10-24');
    const retry = await logEntry(db, {
      habitId: h.id,
      loggedAt: AT_0030_OCT25,
      clientEntryId: key,
    });
    expect(retry.id).toBe(first.id);
    expect(retry.localDate).toBe('2026-10-24');
    expect(await listQualifyingDates(db, h.id, 10)).toEqual(['2026-10-24']);
  });
});
