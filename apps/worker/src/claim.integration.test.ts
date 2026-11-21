import {
  claimDuePeriods,
  db,
  listPeriodsForTower,
  recordEntry,
  transitionPeriod,
  verifyTower,
} from '@tower-of-habit/db';
import { useScenarios, SCENARIO_NOW } from '@tower-of-habit/db/testing/vitest';
import { allMembersDormant } from '@tower-of-habit/shared/testing';
import { describe, expect, it } from 'vitest';
import { createEvaluator } from '@tower-of-habit/api/evaluation';
import type { Logger } from './logger.js';
import { materialisePeriods } from './sweep.js';
import { runTick } from './tick.js';

const noop = () => {};
const logger: Logger = { info: noop, warn: noop, error: noop };

const scenarios = useScenarios();

const AFTER_DAY5_EVALUATE_AT = new Date('2026-10-28T07:00:00Z');

describe('runTick integration — evaluation wiring', () => {
  it('evaluates a due period as collapsed when no entries exist, verifyTower holds', async () => {
    const s = await scenarios.towerRunningFor(5);
    const tower = s.tower!;
    const now = AFTER_DAY5_EVALUATE_AT;

    const report = await runTick(now, {
      claim: (n) => claimDuePeriods(db, n),
      evaluate: createEvaluator(db, logger),
      logger,
    });

    expect(report.claimed).toBeGreaterThanOrEqual(1);
    expect(report.evaluated).toBeGreaterThanOrEqual(1);

    const periods = await listPeriodsForTower(db, tower.id);
    const day5 = periods.find((p) => p.periodStart === s.periods.at(-1)!.periodStart);
    expect(day5!.state).toBe('evaluated');
    expect(day5!.outcome).toBe('collapsed');

    const verification = await verifyTower(db, tower.id);
    expect(verification.ok).toBe(true);
  });

  it('evaluates a survived period with entries, verifyTower holds', async () => {
    const s = await scenarios.towerRunningFor(5);
    const tower = s.tower!;
    const day5Date = s.periods.at(-1)!.periodStart;
    const now = AFTER_DAY5_EVALUATE_AT;

    for (const m of s.members) {
      await recordEntry(db, {
        habitId: m.habit.id,
        localDate: day5Date,
        loggedAt: SCENARIO_NOW,
        qualifies: true,
      });
    }

    const report = await runTick(now, {
      claim: (n) => claimDuePeriods(db, n),
      evaluate: createEvaluator(db, logger),
      logger,
    });

    expect(report.evaluated).toBeGreaterThanOrEqual(1);

    const periods = await listPeriodsForTower(db, tower.id);
    const day5 = periods.find((p) => p.periodStart === day5Date);
    expect(day5!.state).toBe('evaluated');
    expect(day5!.outcome).toBe('survived');

    const verification = await verifyTower(db, tower.id);
    expect(verification.ok).toBe(true);
  });

  it('full pipeline: materialise → claim → evaluate', async () => {
    const s = await scenarios.towerRunningFor(5);
    const tower = s.tower!;
    const now = AFTER_DAY5_EVALUATE_AT;

    const day5 = s.periods.at(-1)!;
    await transitionPeriod(db, day5.id, { to: 'evaluating' }, now);
    await transitionPeriod(db, day5.id, { to: 'evaluated', outcome: 'survived' }, now);

    const report = await runTick(now, {
      materialise: (n) => materialisePeriods(db, n, logger),
      claim: (n) => claimDuePeriods(db, n),
      evaluate: createEvaluator(db, logger),
      logger,
    });

    expect(report.materialised).toBe(1);

    const periods = await listPeriodsForTower(db, tower.id);
    const day6 = periods.find((p) => p.periodStart > day5.periodEnd);
    expect(day6).toBeDefined();
    expect(day6!.state).toBe('pending');
  });

  it('error isolation: one failed evaluation does not stop others', async () => {
    const s1 = await scenarios.towerRunningFor(5);
    const s2 = await scenarios.towerRunningFor(5);
    const now = AFTER_DAY5_EVALUATE_AT;

    const realEvaluate = createEvaluator(db, logger);
    const failFirstTower = async (towerId: string, periodId: string, n: Date) => {
      if (towerId === s1.tower!.id) throw new Error('simulated crash');
      return realEvaluate(towerId, periodId, n);
    };

    const report = await runTick(now, {
      claim: (n) => claimDuePeriods(db, n),
      evaluate: failFirstTower,
      logger,
    });

    expect(report.evaluated).toBeGreaterThanOrEqual(1);
    expect(report.errored).toBeGreaterThanOrEqual(1);

    const periods2 = await listPeriodsForTower(db, s2.tower!.id);
    const s2Day5 = periods2.find((p) => p.periodStart === s2.periods.at(-1)!.periodStart);
    expect(s2Day5!.state).toBe('evaluated');
  });

  it('crash safety: rolled-back eval leaves period reclaimable', async () => {
    const s = await scenarios.towerRunningFor(5);
    const tower = s.tower!;
    const now = AFTER_DAY5_EVALUATE_AT;

    const claimed = await claimDuePeriods(db, now);
    expect(claimed.length).toBeGreaterThanOrEqual(1);

    const period = claimed.find((p) => p.towerId === tower.id)!;
    expect(period.state).toBe('evaluating');
    expect(period.attempts).toBe(1);

    const farFuture = new Date(now.getTime() + 60 * 60_000);
    const reclaimed = await claimDuePeriods(db, farFuture);
    const reclaimedPeriod = reclaimed.find((p) => p.id === period.id);
    expect(reclaimedPeriod).toBeDefined();
    expect(reclaimedPeriod!.attempts).toBe(2);
  });

  it('verifyTower holds after hibernation', async () => {
    const s = await scenarios.towerRunningFor(5, { members: 2, traits: [allMembersDormant()] });
    const tower = s.tower!;
    const now = AFTER_DAY5_EVALUATE_AT;

    const report = await runTick(now, {
      claim: (n) => claimDuePeriods(db, n),
      evaluate: createEvaluator(db, logger),
      logger,
    });

    expect(report.evaluated).toBeGreaterThanOrEqual(1);

    const periods = await listPeriodsForTower(db, tower.id);
    const day5 = periods.find((p) => p.periodStart === s.periods.at(-1)!.periodStart);
    expect(day5!.state).toBe('evaluated');
    expect(day5!.outcome).toBe('hibernated');

    const verification = await verifyTower(db, tower.id);
    expect(verification.ok).toBe(true);
  });
});
