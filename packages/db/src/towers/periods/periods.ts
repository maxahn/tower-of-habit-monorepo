import { and, asc, desc, eq, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { civilInZone, resolvePeriodWindow } from '@tower-of-habit/shared';
import type { db as appDb } from '../../client.js';
import { towers } from '../schema.js';
import { TowerNotFoundError } from '../towers.js';
import { towerPeriods, type PeriodOutcome, type PeriodState } from './schema.js';

type Db = typeof appDb;
export type TowerPeriod = typeof towerPeriods.$inferSelect;
// State, outcome, timestamps and attempts are scheduler-owned: they change only
// through claimDuePeriods and transitionPeriod.
export type NewTowerPeriod = Pick<
  typeof towerPeriods.$inferInsert,
  'towerId' | 'periodStart' | 'periodEnd' | 'deadlineAt' | 'evaluateAt'
>;

/** One worker tick's worth of due periods. Bounds the UPDATE and the lock set. */
export const DEFAULT_CLAIM_LIMIT = 100;
/** How long a worker may hold a claim before another may take it over. */
export const DEFAULT_LEASE_MINUTES = 5;
/**
 * A period claimed this many times is poison and the claim stops picking it
 * up. It then never evaluates, so it needs an operator alert (3.4).
 */
export const MAX_CLAIM_ATTEMPTS = 5;

// An outcome can't be omitted: tower_periods_outcome_iff_evaluated would
// reject it, and the type says so first.
export type PeriodTransition =
  { to: 'evaluating' } | { to: 'evaluated'; outcome: PeriodOutcome } | { to: 'pending' };

export const ALLOWED_PERIOD_TRANSITIONS: Record<PeriodState, readonly PeriodState[]> = {
  pending: ['evaluating'],
  // 'pending' is an explicit release after a failed attempt.
  evaluating: ['evaluated', 'pending'],
  // Terminal: the outcome is decided exactly once, after the window closes.
  evaluated: [],
};

export class IllegalPeriodTransitionError extends Error {
  constructor(
    readonly from: PeriodState,
    readonly to: PeriodState
  ) {
    super(`Illegal period state transition: ${from} -> ${to}`);
    this.name = 'IllegalPeriodTransitionError';
  }
}

export class PeriodNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Tower period not found: ${id}`);
    this.name = 'PeriodNotFoundError';
  }
}

export class TowerNotStartedError extends Error {
  constructor(readonly towerId: string) {
    super(`Tower has no started_at, so no period anchor: ${towerId}`);
    this.name = 'TowerNotStartedError';
  }
}

/** Pure check, usable by the evaluator before it touches the DB. */
export function assertPeriodTransition(from: PeriodState, to: PeriodState): void {
  if (!ALLOWED_PERIOD_TRANSITIONS[from].includes(to)) {
    throw new IllegalPeriodTransitionError(from, to);
  }
}

/** A duplicate surfaces as tower_periods_tower_id_period_start_unique (23505). */
export async function createPeriod(db: Db, input: NewTowerPeriod): Promise<TowerPeriod> {
  const { towerId, periodStart, periodEnd, deadlineAt, evaluateAt } = input;
  const [row] = await db
    .insert(towerPeriods)
    .values({ towerId, periodStart, periodEnd, deadlineAt, evaluateAt })
    .returning();
  return row!;
}

/**
 * Idempotent: the row for (tower_id, period_start), created if absent. Racing
 * callers all get the winner's row; none of them errors.
 *
 * onConflictDoUpdate with a no-op SET, not onConflictDoNothing + re-select.
 * DO NOTHING doesn't wait on an UNCOMMITTED conflicting row, it returns zero
 * rows at once, so the loser's re-select could find nothing for a period that
 * is about to exist. DO UPDATE blocks on the winner and returns its row. The
 * SET writes back the value that conflicted, so the winner's instants stand.
 */
export async function ensurePeriod(db: Db, input: NewTowerPeriod): Promise<TowerPeriod> {
  const { towerId, periodStart, periodEnd, deadlineAt, evaluateAt } = input;
  const [row] = await db
    .insert(towerPeriods)
    .values({ towerId, periodStart, periodEnd, deadlineAt, evaluateAt })
    .onConflictDoUpdate({
      target: [towerPeriods.towerId, towerPeriods.periodStart],
      set: { towerId: sql`excluded.tower_id` },
    })
    .returning();
  return row!;
}

export async function getPeriod(db: Db, id: string): Promise<TowerPeriod | undefined> {
  const [row] = await db.select().from(towerPeriods).where(eq(towerPeriods.id, id));
  return row;
}

export async function getPeriodForDate(
  db: Db,
  towerId: string,
  periodStart: string
): Promise<TowerPeriod | undefined> {
  const [row] = await db
    .select()
    .from(towerPeriods)
    .where(and(eq(towerPeriods.towerId, towerId), eq(towerPeriods.periodStart, periodStart)));
  return row;
}

/** Most recent first. Served by tower_periods_tower_id_period_start_unique. */
export async function listPeriodsForTower(
  db: Db,
  towerId: string,
  limit = 30
): Promise<TowerPeriod[]> {
  return db
    .select()
    .from(towerPeriods)
    .where(eq(towerPeriods.towerId, towerId))
    .orderBy(desc(towerPeriods.periodStart))
    .limit(limit);
}

/**
 * The period covering `now`, created if absent. The arithmetic all lives in
 * @tower-of-habit/shared; this reads the tower and hands the numbers over.
 *
 * started_at is the period anchor. A draft tower has none, and generating
 * periods for one would silently invent a boundary.
 */
export async function ensureCurrentPeriod(
  db: Db,
  towerId: string,
  now: Date
): Promise<TowerPeriod> {
  const [tower] = await db.select().from(towers).where(eq(towers.id, towerId));
  if (!tower) throw new TowerNotFoundError(towerId);
  if (!tower.startedAt) throw new TowerNotStartedError(towerId);
  const w = resolvePeriodWindow({
    periodUnit: tower.periodUnit,
    periodLength: tower.periodLength,
    weekResetDay: tower.weekResetDay,
    anchorDate: civilInZone(tower.startedAt, tower.timezone).date,
    on: civilInZone(now, tower.timezone).date,
    deadlineTime: tower.deadlineTime,
    timeZone: tower.timezone,
    graceMinutes: tower.graceWindowMinutes,
  });
  return ensurePeriod(db, {
    towerId,
    periodStart: w.periodStart,
    periodEnd: w.periodEnd,
    deadlineAt: w.deadlineAt,
    evaluateAt: w.evaluateAt,
  });
}

/**
 * The scheduler's claim (3.4): every period whose grace window has closed,
 * moved to 'evaluating' and handed to this worker, in ONE statement.
 *
 *   state = 'pending' AND evaluate_at <= now
 *       Keys on evaluate_at, NEVER deadline_at. Claiming on the deadline would
 *       evaluate before the grace window closed, and every late log would
 *       arrive after its period was already decided.
 *   no lower bound on evaluate_at
 *       Finds ALL due periods, not just the current one, so a worker that was
 *       down for two hours catches up instead of silently skipping.
 *   OR state = 'evaluating' AND claimed_at < now - lease AND attempts < max
 *       Takes over a lease abandoned by a crashed worker, boundedly.
 *   FOR UPDATE SKIP LOCKED
 *       Concurrent workers partition the queue instead of blocking.
 *
 * The states are SQL literals rather than eq(..., 'pending'): a bind
 * parameter isn't provably equal to a partial index predicate at plan time, so
 * a generic plan couldn't use periods_due.
 *
 * One statement, not a transaction around select-then-update: the claim
 * commits at once and the worker evaluates outside any lock. The 'evaluating'
 * STATE is the lease, not the row lock. A lock held for the whole evaluation
 * would vanish the moment the connection dropped, the one time it should stay.
 */
export async function claimDuePeriods(
  db: Db,
  now: Date,
  limit = DEFAULT_CLAIM_LIMIT,
  leaseMinutes = DEFAULT_LEASE_MINUTES
): Promise<TowerPeriod[]> {
  const leaseCutoff = new Date(now.getTime() - leaseMinutes * 60_000);
  const due = db.$with('due').as(
    db
      .select({ id: towerPeriods.id })
      .from(towerPeriods)
      .where(
        or(
          and(sql`${towerPeriods.state} = 'pending'`, lte(towerPeriods.evaluateAt, now)),
          and(
            sql`${towerPeriods.state} = 'evaluating'`,
            lt(towerPeriods.claimedAt, leaseCutoff),
            lt(towerPeriods.attempts, MAX_CLAIM_ATTEMPTS)
          )
        )
      )
      .orderBy(asc(towerPeriods.evaluateAt))
      .limit(limit)
      .for('update', { skipLocked: true })
  );
  const claimed = await db
    .with(due)
    .update(towerPeriods)
    .set({ state: 'evaluating', claimedAt: now, attempts: sql`${towerPeriods.attempts} + 1` })
    .where(inArray(towerPeriods.id, db.select({ id: due.id }).from(due)))
    .returning();
  // UPDATE ... RETURNING has no defined order, and callers rely on oldest-first.
  return claimed.sort((a, b) => a.evaluateAt.getTime() - b.evaluateAt.getTime());
}

export async function transitionPeriod(
  db: Db,
  id: string,
  t: PeriodTransition
): Promise<TowerPeriod> {
  const current = await getPeriod(db, id);
  if (!current) throw new PeriodNotFoundError(id);
  const from = current.state;
  assertPeriodTransition(from, t.to);

  const [row] = await db
    .update(towerPeriods)
    .set({
      state: t.to,
      // Outcome and evaluated_at are set iff evaluated
      // (tower_periods_outcome_iff_evaluated).
      ...(t.to === 'evaluated'
        ? { outcome: t.outcome, evaluatedAt: new Date() }
        : { outcome: null, evaluatedAt: null }),
      // Releasing to 'pending' keeps claimed_at: when the failed attempt began.
      ...(t.to === 'evaluating'
        ? { claimedAt: new Date(), attempts: sql`${towerPeriods.attempts} + 1` }
        : {}),
    })
    // Conditioning on the observed `from` makes a concurrent transition lose
    // cleanly (zero rows) instead of overwriting.
    .where(and(eq(towerPeriods.id, id), eq(towerPeriods.state, from)))
    .returning();
  if (!row) {
    const latest = await getPeriod(db, id);
    if (!latest) throw new PeriodNotFoundError(id);
    throw new IllegalPeriodTransitionError(latest.state, t.to);
  }
  return row;
}

export async function deletePeriod(db: Db, id: string): Promise<void> {
  await db.delete(towerPeriods).where(eq(towerPeriods.id, id));
}
