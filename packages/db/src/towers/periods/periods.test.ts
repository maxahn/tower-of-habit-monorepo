import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePeriodWindow } from '@tower-of-habit/shared';
import {
  ALLOWED_PERIOD_TRANSITIONS,
  assertPeriodTransition,
  claimDuePeriods,
  createPeriod,
  deletePeriod,
  ensureCurrentPeriod,
  ensurePeriod,
  getPeriod,
  getPeriodForDate,
  IllegalPeriodTransitionError,
  listPeriodsForTower,
  MAX_CLAIM_ATTEMPTS,
  PeriodNotFoundError,
  TowerNotStartedError,
  transitionPeriod,
  type NewTowerPeriod,
  type PeriodTransition,
} from './periods.js';
import { users } from '../../users/schema.js';
import { createTower, deleteTower, type NewTower } from '../towers.js';
import { towers } from '../schema.js';
import { towerPeriods, type PeriodState } from './schema.js';
import { db, pgError, useTestOwner } from '../../test-utils.js';

const EDM = 'America/Edmonton';
// Edmonton 2026: MST -> MDT at 2026-03-08T09:00Z (local 02:00 -> 03:00, so
// 02:00-02:59 never happens); MDT -> MST at 2026-11-01T08:00Z (local
// 02:00 -> 01:00, so 01:00-01:59 happens twice).
const SPRING_FORWARD = '2026-03-08';
const FALL_BACK = '2026-11-01';

const at = (iso: string) => new Date(iso);
const plusMinutes = (d: Date, minutes: number) => new Date(d.getTime() + minutes * 60_000);

const owner = useTestOwner();

// host_id is ON DELETE RESTRICT, so towers must go before the owner;
// tower_periods cascades from towers. Vitest runs afterEach hooks in reverse
// registration order: this one runs first.
afterEach(async () => {
  await db.delete(towers).where(eq(towers.hostId, owner()));
});

function tower(overrides: Partial<NewTower> = {}) {
  return createTower(db, {
    hostId: owner(),
    name: 'Morning run',
    deadlineTime: '22:00',
    timezone: EDM,
    ...overrides,
  });
}

/** An active tower, anchored at `startedAt`. */
async function startedTower(startedAt: Date, overrides: Partial<NewTower> = {}) {
  const t = await tower(overrides);
  await db.update(towers).set({ lifecycle: 'active', startedAt }).where(eq(towers.id, t.id));
  return t;
}

/** One daily period ending on `d`, 22:00 MST deadline + 120 grace. */
function period(towerId: string, d = '2026-03-07'): NewTowerPeriod {
  return {
    towerId,
    periodStart: d,
    periodEnd: d,
    deadlineAt: at('2026-03-08T05:00:00.000Z'),
    evaluateAt: at('2026-03-08T07:00:00.000Z'),
  };
}

/** Bypasses the service, for scheduler-owned columns and constraint probes. */
function rawPeriod(values: Partial<typeof towerPeriods.$inferInsert> & { towerId: string }) {
  return db
    .insert(towerPeriods)
    .values({ ...period(values.towerId), ...values })
    .returning();
}

/** A pending period due at `evaluateAt`, on its own date so several can coexist. */
async function due(towerId: string, d: string, evaluateAt = at(`${d}T07:00:00.000Z`)) {
  const [p] = await rawPeriod({
    towerId,
    periodStart: d,
    periodEnd: d,
    deadlineAt: plusMinutes(evaluateAt, -120),
    evaluateAt,
  });
  return p!;
}

async function checkViolation(p: Promise<unknown>) {
  const e = await pgError(p);
  expect(e.code).toBe('23514');
  return e.constraint_name;
}

describe('period instants across DST (DR-001)', () => {
  it.each([
    {
      end: '2026-03-07',
      deadline: '22:00',
      grace: 120,
      deadlineAt: '2026-03-08T05:00:00.000Z',
      evaluateAt: '2026-03-08T07:00:00.000Z',
    },
    // The spring-forward day itself: 22:00 is MDT by then.
    {
      end: SPRING_FORWARD,
      deadline: '22:00',
      grace: 120,
      deadlineAt: '2026-03-09T04:00:00.000Z',
      evaluateAt: '2026-03-09T06:00:00.000Z',
    },
    // THE case the ticket calls out. 01:00 MST is 08:00Z, and two REAL hours
    // later is 10:00Z, which reads 04:00 because an hour vanished in between.
    // Wall-clock arithmetic would say 03:00 = 09:00Z: an hour early.
    {
      end: SPRING_FORWARD,
      deadline: '01:00',
      grace: 120,
      deadlineAt: '2026-03-08T08:00:00.000Z',
      evaluateAt: '2026-03-08T10:00:00.000Z',
    },
    {
      end: '2026-10-31',
      deadline: '22:00',
      grace: 120,
      deadlineAt: '2026-11-01T04:00:00.000Z',
      evaluateAt: '2026-11-01T06:00:00.000Z',
    },
    // The mirror: wall-clock arithmetic would say 02:30 = 09:30Z, an hour late.
    {
      end: FALL_BACK,
      deadline: '00:30',
      grace: 120,
      deadlineAt: '2026-11-01T06:30:00.000Z',
      evaluateAt: '2026-11-01T08:30:00.000Z',
    },
    {
      end: FALL_BACK,
      deadline: '22:00',
      grace: 120,
      deadlineAt: '2026-11-02T05:00:00.000Z',
      evaluateAt: '2026-11-02T07:00:00.000Z',
    },
    // grace 0 reproduces the hard cliff: one instant.
    {
      end: SPRING_FORWARD,
      deadline: '22:00',
      grace: 0,
      deadlineAt: '2026-03-09T04:00:00.000Z',
      evaluateAt: '2026-03-09T04:00:00.000Z',
    },
  ])('$end @ $deadline + $grace stores $deadlineAt / $evaluateAt', async (c) => {
    const t = await tower({ deadlineTime: c.deadline, graceWindowMinutes: c.grace });
    // From the tower row as stored, so deadline_time's '22:00:00' read-back
    // form is in the path.
    const w = resolvePeriodWindow({
      periodUnit: t.periodUnit,
      periodLength: t.periodLength,
      weekResetDay: t.weekResetDay,
      anchorDate: c.end,
      on: c.end,
      deadlineTime: t.deadlineTime,
      timeZone: t.timezone,
      graceMinutes: t.graceWindowMinutes,
    });
    const p = await createPeriod(db, { towerId: t.id, ...w });
    // Read back, so the timestamptz round trip is inside the assertion.
    const stored = (await getPeriod(db, p.id))!;
    expect(stored.deadlineAt.toISOString()).toBe(c.deadlineAt);
    expect(stored.evaluateAt.toISOString()).toBe(c.evaluateAt);
  });

  it('ensureCurrentPeriod materialises across the spring-forward night', async () => {
    const t = await startedTower(at('2026-03-01T15:00:00.000Z'), { deadlineTime: '01:00' });
    // 2026-03-08 12:00 MDT.
    const p = await ensureCurrentPeriod(db, t.id, at('2026-03-08T18:00:00.000Z'));
    expect(p).toMatchObject({
      periodStart: SPRING_FORWARD,
      periodEnd: SPRING_FORWARD,
      deadlineAt: at('2026-03-08T08:00:00.000Z'),
      evaluateAt: at('2026-03-08T10:00:00.000Z'),
    });
  });

  it('ensureCurrentPeriod snaps a weekly tower back to its reset day', async () => {
    // Thursday 2026-03-05, weeks reset Monday (1).
    const t = await startedTower(at('2026-03-05T18:00:00.000Z'), {
      periodUnit: 'week',
      weekResetDay: 1,
    });
    const p = await ensureCurrentPeriod(db, t.id, at('2026-03-06T18:00:00.000Z'));
    expect(p).toMatchObject({
      periodStart: '2026-03-02',
      periodEnd: SPRING_FORWARD,
      // Sunday 22:00 MDT; the clocks changed that morning.
      deadlineAt: at('2026-03-09T04:00:00.000Z'),
    });
  });

  it('ensureCurrentPeriod is idempotent across ticks', async () => {
    const t = await startedTower(at('2026-03-01T15:00:00.000Z'));
    const p1 = await ensureCurrentPeriod(db, t.id, at('2026-03-07T18:00:00.000Z'));
    const p2 = await ensureCurrentPeriod(db, t.id, at('2026-03-07T20:00:00.000Z'));
    expect(p2.id).toBe(p1.id);
    expect(await listPeriodsForTower(db, t.id)).toHaveLength(1);
  });

  it('ensureCurrentPeriod refuses a tower that has not started', async () => {
    const t = await tower();
    await expect(
      ensureCurrentPeriod(db, t.id, at('2026-03-07T18:00:00.000Z'))
    ).rejects.toBeInstanceOf(TowerNotStartedError);
  });
});

describe('the grace window is not claimable (3.4 keys on evaluate_at)', () => {
  const DEADLINE = at('2026-03-08T05:00:00.000Z');
  const EVALUATE = at('2026-03-08T07:00:00.000Z');

  // Every one of these is AFTER the deadline and BEFORE the window closes. A
  // scheduler keyed on deadline_at would claim all of them.
  it.each([0, 1, 60, 119])('does not claim %i minutes past the deadline', async (minutes) => {
    const t = await tower();
    const [p] = await rawPeriod({ towerId: t.id });
    expect(await claimDuePeriods(db, plusMinutes(DEADLINE, minutes))).toEqual([]);
    expect(await getPeriod(db, p!.id)).toMatchObject({
      state: 'pending',
      claimedAt: null,
      attempts: 0,
    });
  });

  it('does not claim one millisecond before evaluate_at', async () => {
    const t = await tower();
    await rawPeriod({ towerId: t.id });
    expect(await claimDuePeriods(db, new Date(EVALUATE.getTime() - 1))).toEqual([]);
  });

  it('claims at exactly evaluate_at (the comparison is <=)', async () => {
    const t = await tower();
    const [p] = await rawPeriod({ towerId: t.id });
    const claimed = await claimDuePeriods(db, EVALUATE);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      id: p!.id,
      state: 'evaluating',
      claimedAt: EVALUATE,
      attempts: 1,
    });
  });

  it('claims nothing twice: the next tick finds no pending rows', async () => {
    const t = await tower();
    await rawPeriod({ towerId: t.id });
    expect(await claimDuePeriods(db, EVALUATE)).toHaveLength(1);
    expect(await claimDuePeriods(db, plusMinutes(EVALUATE, 1))).toEqual([]);
  });

  // A missed tick is survivable: ALL due periods, not only the current one.
  it('catches up on every overdue period, oldest first', async () => {
    const t = await tower();
    for (const d of ['2026-03-03', '2026-03-01', '2026-03-02']) await due(t.id, d);
    const notYet = await due(t.id, '2026-03-09');
    const claimed = await claimDuePeriods(db, at('2026-03-05T00:00:00.000Z'));
    expect(claimed.map((p) => p.periodStart)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03']);
    expect((await getPeriod(db, notYet.id))!.state).toBe('pending');
  });

  it('honours the limit, oldest first', async () => {
    const t = await tower();
    for (const d of ['2026-03-01', '2026-03-02', '2026-03-03']) await due(t.id, d);
    const claimed = await claimDuePeriods(db, at('2026-03-05T00:00:00.000Z'), 2);
    expect(claimed.map((p) => p.periodStart)).toEqual(['2026-03-01', '2026-03-02']);
  });

  it('serves the pending claim from periods_due', async () => {
    const plan = await db.transaction(async (tx) => {
      // A small table is seq-scanned whatever the index says.
      await tx.execute(sql`set local enable_seqscan = off`);
      return tx.execute(sql`explain select id from tower_periods
        where state = 'pending' and evaluate_at <= now()
        order by evaluate_at limit 100 for update skip locked`);
    });
    expect(JSON.stringify(plan)).toContain('periods_due');
  });
});

describe('lease and reclaim', () => {
  const NOW = at('2026-03-05T00:00:00.000Z');

  it('takes over a claim older than the lease, counting the attempt', async () => {
    const t = await tower();
    const p = await due(t.id, '2026-03-01');
    expect(await claimDuePeriods(db, NOW)).toHaveLength(1);
    // Within the lease: still held.
    expect(await claimDuePeriods(db, plusMinutes(NOW, 4))).toEqual([]);
    // Past it: the worker is presumed dead.
    const [again] = await claimDuePeriods(db, plusMinutes(NOW, 6));
    expect(again).toMatchObject({
      id: p.id,
      state: 'evaluating',
      attempts: 2,
      claimedAt: plusMinutes(NOW, 6),
    });
  });

  it('gives up on a poison period after MAX_CLAIM_ATTEMPTS', async () => {
    const t = await tower();
    const p = await due(t.id, '2026-03-01');
    let now = NOW;
    for (let i = 1; i <= MAX_CLAIM_ATTEMPTS; i++) {
      expect(await claimDuePeriods(db, now)).toHaveLength(1);
      now = plusMinutes(now, 10);
    }
    expect(await claimDuePeriods(db, now)).toEqual([]);
    expect(await getPeriod(db, p.id)).toMatchObject({
      state: 'evaluating',
      attempts: MAX_CLAIM_ATTEMPTS,
    });
  });

  it('never reclaims an evaluated period', async () => {
    const t = await tower();
    const p = await due(t.id, '2026-03-01');
    await claimDuePeriods(db, NOW);
    await transitionPeriod(db, p.id, { to: 'evaluated', outcome: 'survived' });
    expect(await claimDuePeriods(db, plusMinutes(NOW, 60))).toEqual([]);
  });

  it('reclaims a released period immediately', async () => {
    const t = await tower();
    const p = await due(t.id, '2026-03-01');
    await claimDuePeriods(db, NOW);
    const released = await transitionPeriod(db, p.id, { to: 'pending' });
    // claimed_at survives the release: when the failed attempt began.
    expect(released).toMatchObject({ state: 'pending', claimedAt: NOW, attempts: 1 });
    expect(await claimDuePeriods(db, plusMinutes(NOW, 1))).toMatchObject([
      { id: p.id, attempts: 2 },
    ]);
  });
});

describe('concurrent workers (FOR UPDATE SKIP LOCKED)', () => {
  const NOW = at('2026-03-05T00:00:00.000Z');

  // Deterministic: A claims one row and holds its transaction open; B asks for
  // ten through the real service and must come straight back with the other
  // row, neither blocking on A's lock nor taking A's row.
  it('a second worker skips the rows the first holds instead of waiting', async () => {
    const t = await tower();
    await due(t.id, '2026-03-01');
    await due(t.id, '2026-03-02');
    const a = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      let held: () => void = () => {};
      let claimed: () => void = () => {};
      const release = new Promise<void>((r) => {
        held = r;
      });
      const aHoldsOne = new Promise<void>((r) => {
        claimed = r;
      });

      let aRows: { period_start: string }[] = [];
      const txA = a.begin(async (tx) => {
        aRows = await tx`
          with due as (
            select id from tower_periods
            where state = 'pending' and evaluate_at <= ${NOW}
            order by evaluate_at limit 1 for update skip locked)
          update tower_periods set state = 'evaluating', claimed_at = ${NOW}, attempts = attempts + 1
          where id in (select id from due) returning period_start::text`;
        claimed();
        await release;
      });
      await aHoldsOne;

      // Without SKIP LOCKED, B would block on A's row until A commits.
      const timeout = new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 2000));
      const b = await Promise.race([claimDuePeriods(db, NOW, 10), timeout]);
      held();
      await txA;

      expect(b).not.toBe('blocked');
      const bRows = b as Awaited<ReturnType<typeof claimDuePeriods>>;
      expect(aRows.map((r) => r.period_start)).toEqual(['2026-03-01']);
      expect(bRows.map((r) => r.periodStart)).toEqual(['2026-03-02']);
      // Nothing left, nothing claimed twice.
      expect(await claimDuePeriods(db, NOW)).toEqual([]);
    } finally {
      await a.end();
    }
  });

  it('concurrent claims partition the queue with no duplicates', async () => {
    const t = await tower();
    const ids = new Set<string>();
    for (let d = 1; d <= 8; d++) ids.add((await due(t.id, `2026-02-0${d}`)).id);
    const workers = Array.from({ length: 4 }, () =>
      postgres(process.env.DATABASE_URL!, { max: 1 })
    );
    try {
      const results = await Promise.all(
        workers.map(
          (w) => w<{ id: string }[]>`
            with due as (
              select id from tower_periods
              where tower_id = ${t.id} and state = 'pending' and evaluate_at <= ${NOW}
              order by evaluate_at limit 3 for update skip locked)
            update tower_periods set state = 'evaluating', claimed_at = ${NOW}, attempts = attempts + 1
            where id in (select id from due) returning id`
        )
      );
      const claimed = results.flatMap((rows) => rows.map((r) => r.id));
      expect(claimed).toHaveLength(new Set(claimed).size);
      // Four workers taking up to three each can cover all eight; whatever any
      // single run left over is still pending and one more tick finishes it.
      const rest = await claimDuePeriods(db, NOW);
      expect(new Set([...claimed, ...rest.map((p) => p.id)])).toEqual(ids);
    } finally {
      await Promise.all(workers.map((w) => w.end()));
    }
  });
});

describe('tower_periods_tower_id_period_start_unique', () => {
  it('rejects a second period for the same tower and start', async () => {
    const t = await tower();
    await createPeriod(db, period(t.id));
    expect(await pgError(createPeriod(db, period(t.id)))).toMatchObject({
      code: '23505',
      constraint_name: 'tower_periods_tower_id_period_start_unique',
    });
  });

  it('allows the same start on another tower, and another start on this one', async () => {
    const [t1, t2] = [await tower(), await tower()];
    await createPeriod(db, period(t1.id));
    await createPeriod(db, period(t2.id));
    await createPeriod(db, period(t1.id, '2026-03-08'));
    expect(await listPeriodsForTower(db, t1.id)).toHaveLength(2);
  });

  // Two workers racing to create tomorrow's period: one row, and the losers
  // get the winner's row back rather than an error.
  it('lets concurrent ensurePeriod calls all succeed on one row', async () => {
    const t = await tower();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ensurePeriod(db, period(t.id)))
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await listPeriodsForTower(db, t.id)).toHaveLength(1);
  });

  it("ensurePeriod keeps the winner's instants", async () => {
    const t = await tower();
    const first = await ensurePeriod(db, period(t.id));
    const second = await ensurePeriod(db, {
      ...period(t.id),
      deadlineAt: at('2026-03-08T06:00:00.000Z'),
      evaluateAt: at('2026-03-08T08:00:00.000Z'),
    });
    expect(second).toEqual(first);
  });
});

describe('tower_periods CRUD', () => {
  it('inserts with spec defaults', async () => {
    const t = await tower();
    const p = await createPeriod(db, period(t.id));
    expect(p).toMatchObject({
      towerId: t.id,
      periodStart: '2026-03-07',
      periodEnd: '2026-03-07',
      state: 'pending',
      outcome: null,
      evaluatedAt: null,
      claimedAt: null,
      attempts: 0,
      freebieSource: null,
      freebieGrantedBy: null,
    });
    expect(p.createdAt).toBeInstanceOf(Date);
  });

  it('finds a period by tower and start', async () => {
    const t = await tower();
    const p = await createPeriod(db, period(t.id));
    expect(await getPeriodForDate(db, t.id, '2026-03-07')).toEqual(p);
    expect(await getPeriodForDate(db, t.id, '2026-03-08')).toBeUndefined();
  });

  it('lists most recent first', async () => {
    const t = await tower();
    for (const d of ['2026-03-01', '2026-03-03', '2026-03-02']) await due(t.id, d);
    const listed = await listPeriodsForTower(db, t.id);
    expect(listed.map((p) => p.periodStart)).toEqual(['2026-03-03', '2026-03-02', '2026-03-01']);
  });

  it('createPeriod ignores scheduler-owned fields smuggled in untyped', async () => {
    const t = await tower();
    const p = await createPeriod(db, {
      ...period(t.id),
      state: 'evaluated',
      outcome: 'survived',
      attempts: 3,
    } as never);
    expect(p).toMatchObject({ state: 'pending', outcome: null, attempts: 0 });
  });

  it('deletes', async () => {
    const t = await tower();
    const p = await createPeriod(db, period(t.id));
    await deletePeriod(db, p.id);
    expect(await getPeriod(db, p.id)).toBeUndefined();
  });

  it('cascades from the tower', async () => {
    const t = await tower();
    const p = await createPeriod(db, period(t.id));
    await deleteTower(db, t.id);
    expect(await getPeriod(db, p.id)).toBeUndefined();
  });
});

describe('tower_periods constraints', () => {
  const CLAIMED = at('2026-03-08T07:00:00.000Z');

  it.each([
    {
      values: { evaluateAt: at('2026-03-08T04:59:59.000Z') },
      name: 'tower_periods_evaluate_after_deadline',
    },
    {
      values: { periodStart: '2026-03-08', periodEnd: '2026-03-07' },
      name: 'tower_periods_end_after_start',
    },
    {
      values: { state: 'evaluated' as const, claimedAt: CLAIMED },
      name: 'tower_periods_outcome_iff_evaluated',
    },
    { values: { outcome: 'survived' as const }, name: 'tower_periods_outcome_iff_evaluated' },
    {
      values: { state: 'evaluated' as const, outcome: 'survived' as const, claimedAt: CLAIMED },
      name: 'tower_periods_outcome_iff_evaluated',
    },
    { values: { state: 'evaluating' as const }, name: 'tower_periods_claimed_unless_pending' },
    // The hole a single (state = 'evaluated') = (a AND b) form leaves open.
    { values: { evaluatedAt: CLAIMED }, name: 'tower_periods_outcome_iff_evaluated' },
    { values: { attempts: -1 }, name: 'tower_periods_attempts_nonnegative' },
    // The case IS NOT DISTINCT FROM exists for: a plain = would let this through.
    {
      values: { freebieSource: 'system' as const },
      name: 'tower_periods_freebie_fields_iff_freebie',
    },
    {
      values: {
        state: 'evaluated' as const,
        outcome: 'freebie' as const,
        evaluatedAt: CLAIMED,
        claimedAt: CLAIMED,
      },
      name: 'tower_periods_freebie_fields_iff_freebie',
    },
    {
      values: {
        state: 'evaluated' as const,
        outcome: 'survived' as const,
        evaluatedAt: CLAIMED,
        claimedAt: CLAIMED,
        freebieSource: 'earned' as const,
      },
      name: 'tower_periods_freebie_fields_iff_freebie',
    },
  ])('rejects $values', async ({ values, name }) => {
    const t = await tower();
    expect(await checkViolation(rawPeriod({ towerId: t.id, ...values }))).toBe(name);
  });

  it('rejects a granted_by without a source', async () => {
    const t = await tower();
    expect(await checkViolation(rawPeriod({ towerId: t.id, freebieGrantedBy: owner() }))).toBe(
      'tower_periods_freebie_granted_by_requires_source'
    );
  });

  it('accepts a granted freebie', async () => {
    const t = await tower();
    const [p] = await rawPeriod({
      towerId: t.id,
      state: 'evaluated',
      outcome: 'freebie',
      evaluatedAt: CLAIMED,
      claimedAt: CLAIMED,
      freebieSource: 'host_granted',
      freebieGrantedBy: owner(),
    });
    expect(p).toMatchObject({ outcome: 'freebie', freebieSource: 'host_granted' });
  });

  it('accepts grace 0, where the two instants coincide', async () => {
    const t = await tower();
    const instant = at('2026-03-08T05:00:00.000Z');
    const [p] = await rawPeriod({ towerId: t.id, deadlineAt: instant, evaluateAt: instant });
    expect(p!.evaluateAt).toEqual(p!.deadlineAt);
  });

  it('rejects a nonexistent tower', async () => {
    expect(await pgError(createPeriod(db, period(crypto.randomUUID())))).toMatchObject({
      code: '23503',
      constraint_name: 'tower_periods_tower_id_towers_id_fk',
    });
  });

  it('blocks deleting a user who granted a freebie', async () => {
    const t = await tower();
    const [p] = await rawPeriod({
      towerId: t.id,
      state: 'evaluated',
      outcome: 'freebie',
      evaluatedAt: CLAIMED,
      claimedAt: CLAIMED,
      freebieSource: 'host_granted',
      freebieGrantedBy: owner(),
    });
    // Clear the grant so the owner hook can still delete the user afterwards.
    const e = await pgError(db.delete(users).where(eq(users.id, owner())));
    await db.delete(towerPeriods).where(eq(towerPeriods.id, p!.id));
    expect(e.code).toBe('23503');
  });

  it.each([-1, 7])('towers rejects week_reset_day %i', async (weekResetDay) => {
    expect(await checkViolation(tower({ periodUnit: 'week', weekResetDay }))).toBe(
      'towers_week_reset_day_range'
    );
  });

  it.each([0, 6])('towers accepts week_reset_day %i', async (weekResetDay) => {
    expect((await tower({ periodUnit: 'week', weekResetDay })).weekResetDay).toBe(weekResetDay);
  });
});

describe('period transitions', () => {
  const STATES: PeriodState[] = ['pending', 'evaluating', 'evaluated'];
  const cases = STATES.flatMap((from) =>
    STATES.map((to) => ({ from, to, legal: ALLOWED_PERIOD_TRANSITIONS[from].includes(to) }))
  );

  const transition = (to: PeriodState): PeriodTransition =>
    to === 'evaluated' ? { to, outcome: 'survived' } : { to };

  /** A period already in `state`, reached through the service. */
  async function inState(state: PeriodState) {
    const t = await tower();
    const p = await createPeriod(db, period(t.id));
    if (state === 'pending') return p;
    await transitionPeriod(db, p.id, { to: 'evaluating' });
    if (state === 'evaluating') return (await getPeriod(db, p.id))!;
    return transitionPeriod(db, p.id, { to: 'evaluated', outcome: 'survived' });
  }

  it.each(cases.filter((c) => c.legal))('allows $from -> $to', async ({ from, to }) => {
    const p = await inState(from);
    const next = await transitionPeriod(db, p.id, transition(to));
    expect(next.state).toBe(to);
  });

  it.each(cases.filter((c) => !c.legal))('rejects $from -> $to', async ({ from, to }) => {
    expect(() => assertPeriodTransition(from, to)).toThrow(IllegalPeriodTransitionError);
    const p = await inState(from);
    await expect(transitionPeriod(db, p.id, transition(to))).rejects.toBeInstanceOf(
      IllegalPeriodTransitionError
    );
    expect((await getPeriod(db, p.id))!.state).toBe(from);
  });

  it('sets outcome and evaluated_at on evaluated', async () => {
    const p = await inState('evaluating');
    const done = await transitionPeriod(db, p.id, { to: 'evaluated', outcome: 'collapsed' });
    expect(done.outcome).toBe('collapsed');
    expect(done.evaluatedAt).toBeInstanceOf(Date);
  });

  it('a concurrent transition loses cleanly rather than overwriting', async () => {
    const p = await inState('evaluating');
    const results = await Promise.allSettled([
      transitionPeriod(db, p.id, { to: 'evaluated', outcome: 'survived' }),
      transitionPeriod(db, p.id, { to: 'evaluated', outcome: 'collapsed' }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    expect((await getPeriod(db, p.id))!.outcome).toBe(
      (won[0] as PromiseFulfilledResult<{ outcome: string }>).value.outcome
    );
  });

  it('throws for a missing period', async () => {
    await expect(
      transitionPeriod(db, crypto.randomUUID(), { to: 'evaluating' })
    ).rejects.toBeInstanceOf(PeriodNotFoundError);
  });

  it('requires an outcome to evaluate at the type level', () => {
    // @ts-expect-error an outcome is required
    const t: PeriodTransition = { to: 'evaluated' };
    void t;
  });
});
