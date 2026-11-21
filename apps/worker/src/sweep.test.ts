import {
  db,
  deletePeriod,
  listPeriodsForTower,
  transitionPeriod,
  towers,
} from '@tower-of-habit/db';
import { useScenarios, SCENARIO_NOW } from '@tower-of-habit/db/testing/vitest';
import { addDays, resolvePeriodWindow, civilInZone } from '@tower-of-habit/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Logger } from './logger.js';
import { materialisePeriods } from './sweep.js';

const noop = () => {};
const logger: Logger = { info: noop, warn: noop, error: noop };
const now = SCENARIO_NOW;

const scenarios = useScenarios();

/** The latest period for a tower, by periodStart descending. */
async function latestPeriod(towerId: string) {
  const rows = await listPeriodsForTower(db, towerId, 1);
  return rows[0]!;
}

/** Compute the expected next period window from a tower row and a periodStart. */
function expectedWindow(
  tower: {
    periodUnit: 'day' | 'week';
    periodLength: number;
    weekResetDay: number | null;
    startedAt: Date | null;
    timezone: string;
    deadlineTime: string;
    graceWindowMinutes: number;
  },
  periodStart: string
) {
  return resolvePeriodWindow({
    periodUnit: tower.periodUnit,
    periodLength: tower.periodLength,
    weekResetDay: tower.weekResetDay,
    anchorDate: civilInZone(tower.startedAt!, tower.timezone).date,
    on: periodStart,
    deadlineTime: tower.deadlineTime,
    timeZone: tower.timezone,
    graceMinutes: tower.graceWindowMinutes,
  });
}

describe('materialisePeriods — core behaviour', () => {
  it('creates the next period for an active tower whose latest period is evaluated', async () => {
    const s = await scenarios.towerRunningFor(5);
    const tower = s.tower!;

    // Day 5 is pending — transition it through evaluating -> evaluated
    const day5 = await latestPeriod(tower.id);
    expect(day5.state).toBe('pending');
    await transitionPeriod(db, day5.id, { to: 'evaluating' }, now);
    await transitionPeriod(db, day5.id, { to: 'evaluated', outcome: 'survived' }, now);

    const count = await materialisePeriods(db, now, logger);
    expect(count).toBe(1);

    const next = await latestPeriod(tower.id);
    expect(next.id).not.toBe(day5.id);
    expect(next.state).toBe('pending');

    const nextStart = addDays(day5.periodEnd, 1);
    expect(next.periodStart).toBe(nextStart);

    const w = expectedWindow(tower, nextStart);
    expect(next.periodEnd).toBe(w.periodEnd);
    expect(next.deadlineAt.toISOString()).toBe(w.deadlineAt.toISOString());
    expect(next.evaluateAt.toISOString()).toBe(w.evaluateAt.toISOString());
  });

  it('does nothing when the latest period is still pending', async () => {
    const s = await scenarios.towerRunningFor(5);
    const tower = s.tower!;

    const before = await listPeriodsForTower(db, tower.id);
    const count = await materialisePeriods(db, now, logger);
    expect(count).toBe(0);

    const after = await listPeriodsForTower(db, tower.id);
    expect(after.length).toBe(before.length);
  });

  it('does nothing for a draft tower', async () => {
    const s = await scenarios.towerRunningFor(1);
    const tower = s.tower!;
    await db
      .update(towers)
      .set({ lifecycle: 'draft', startedAt: null })
      .where(eq(towers.id, tower.id));

    const count = await materialisePeriods(db, now, logger);
    expect(count).toBe(0);
  });

  it('does nothing for a paused tower', async () => {
    const s = await scenarios.towerRunningFor(5);
    const tower = s.tower!;

    const day5 = await latestPeriod(tower.id);
    await transitionPeriod(db, day5.id, { to: 'evaluating' }, now);
    await transitionPeriod(db, day5.id, { to: 'evaluated', outcome: 'survived' }, now);
    await db.update(towers).set({ lifecycle: 'paused' }).where(eq(towers.id, tower.id));

    const count = await materialisePeriods(db, now, logger);
    expect(count).toBe(0);
  });

  it('does nothing for an archived tower', async () => {
    const s = await scenarios.towerRunningFor(5);
    const tower = s.tower!;

    const day5 = await latestPeriod(tower.id);
    await transitionPeriod(db, day5.id, { to: 'evaluating' }, now);
    await transitionPeriod(db, day5.id, { to: 'evaluated', outcome: 'survived' }, now);
    await db.update(towers).set({ lifecycle: 'archived' }).where(eq(towers.id, tower.id));

    const count = await materialisePeriods(db, now, logger);
    expect(count).toBe(0);
  });
});

describe('materialisePeriods — idempotency', () => {
  it('running twice creates only one period', async () => {
    const s = await scenarios.towerRunningFor(5);
    const tower = s.tower!;

    const day5 = await latestPeriod(tower.id);
    await transitionPeriod(db, day5.id, { to: 'evaluating' }, now);
    await transitionPeriod(db, day5.id, { to: 'evaluated', outcome: 'survived' }, now);

    const first = await materialisePeriods(db, now, logger);
    expect(first).toBe(1);

    const second = await materialisePeriods(db, now, logger);
    expect(second).toBe(0);

    const periods = await listPeriodsForTower(db, tower.id);
    const pending = periods.filter((p) => p.state === 'pending');
    expect(pending).toHaveLength(1);
  });

  it('concurrent calls produce exactly one period', async () => {
    const s = await scenarios.towerRunningFor(5);
    const tower = s.tower!;

    const day5 = await latestPeriod(tower.id);
    await transitionPeriod(db, day5.id, { to: 'evaluating' }, now);
    await transitionPeriod(db, day5.id, { to: 'evaluated', outcome: 'survived' }, now);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => materialisePeriods(db, now, logger))
    );

    // All calls succeed (no throws implied by reaching here)
    const total = results.reduce((sum, n) => sum + n, 0);
    // Only one period should have been materialised across all calls
    const periods = await listPeriodsForTower(db, tower.id);
    const pending = periods.filter((p) => p.state === 'pending');
    expect(pending).toHaveLength(1);
    expect(total).toBeGreaterThanOrEqual(1);
  });
});

describe('materialisePeriods — edge cases', () => {
  it('does not create a period before startedAt', async () => {
    const s = await scenarios.towerRunningFor(1);
    const tower = s.tower!;

    // Evaluate the only period so the sweep has work to do
    const p = await latestPeriod(tower.id);
    await transitionPeriod(db, p.id, { to: 'evaluating' }, now);
    await transitionPeriod(db, p.id, { to: 'evaluated', outcome: 'survived' }, now);

    const count = await materialisePeriods(db, now, logger);

    if (count > 0) {
      const next = await latestPeriod(tower.id);
      const startCivil = civilInZone(tower.startedAt!, tower.timezone).date;
      expect(next.periodStart >= startCivil).toBe(true);
    }
  });

  it('materialises for multiple towers in one call', async () => {
    const s1 = await scenarios.towerRunningFor(5);
    const s2 = await scenarios.towerRunningFor(5);

    for (const s of [s1, s2]) {
      const p = await latestPeriod(s.tower!.id);
      await transitionPeriod(db, p.id, { to: 'evaluating' }, now);
      await transitionPeriod(db, p.id, { to: 'evaluated', outcome: 'survived' }, now);
    }

    const count = await materialisePeriods(db, now, logger);
    expect(count).toBe(2);

    for (const s of [s1, s2]) {
      const latest = await latestPeriod(s.tower!.id);
      expect(latest.state).toBe('pending');
    }
  });

  it('skips a tower that already has a pending successor', async () => {
    const s = await scenarios.towerRunningFor(5);
    const tower = s.tower!;

    // Day 4 is evaluated (by deriveTowerState), day 5 is pending — the successor exists
    const periods = await listPeriodsForTower(db, tower.id);
    const day4 = periods.find((p) => p.state === 'evaluated');
    const day5 = periods.find((p) => p.state === 'pending');
    expect(day4).toBeDefined();
    expect(day5).toBeDefined();

    const count = await materialisePeriods(db, now, logger);
    expect(count).toBe(0);
  });

  it('recreates a deleted pending period with identical instants', async () => {
    const s = await scenarios.towerRunningFor(5);
    const tower = s.tower!;

    // Record day 5 (pending) instants before deleting it
    const day5 = await latestPeriod(tower.id);
    expect(day5.state).toBe('pending');
    const original = {
      periodStart: day5.periodStart,
      periodEnd: day5.periodEnd,
      deadlineAt: day5.deadlineAt.toISOString(),
      evaluateAt: day5.evaluateAt.toISOString(),
    };

    await deletePeriod(db, day5.id);

    // The now-latest period (day 4) should be evaluated
    const day4 = await latestPeriod(tower.id);
    expect(day4.state).toBe('evaluated');

    const count = await materialisePeriods(db, now, logger);
    expect(count).toBe(1);

    const recreated = await latestPeriod(tower.id);
    expect(recreated.periodStart).toBe(original.periodStart);
    expect(recreated.periodEnd).toBe(original.periodEnd);
    expect(recreated.deadlineAt.toISOString()).toBe(original.deadlineAt);
    expect(recreated.evaluateAt.toISOString()).toBe(original.evaluateAt);
  });
});
