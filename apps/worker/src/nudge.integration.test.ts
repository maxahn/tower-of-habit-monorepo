import {
  claimDuePeriods,
  db,
  listNotificationsForTower,
  memberships,
  recordEntry,
} from '@tower-of-habit/db';
import { useScenarios, SCENARIO_NOW } from '@tower-of-habit/db/testing/vitest';
import { computePeriodWindow } from '@tower-of-habit/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createEvaluator } from '@tower-of-habit/api/evaluation';
import type { Logger } from './logger.js';
import { processNudge } from './nudge.js';
import { runTick } from './tick.js';

const noop = () => {};
const logger: Logger = { info: noop, warn: noop, error: noop };

const scenarios = useScenarios();

function nudgeAt(tower: Parameters<typeof computePeriodWindow>[0], periodStart: string): Date {
  return new Date(computePeriodWindow(tower, periodStart).nudgeAt);
}

function deadlineAt(tower: Parameters<typeof computePeriodWindow>[0], periodStart: string): Date {
  return new Date(computePeriodWindow(tower, periodStart).deadlineAt);
}

describe('nudge dispatch', () => {
  it('creates nudge notifications for all members who have not logged', async () => {
    const s = await scenarios.towerRunningFor(5, { members: 2 });
    const tower = s.tower!;
    const period5 = s.periods.at(-1)!;
    const now = nudgeAt(tower, period5.periodStart);

    const count = await processNudge(db, period5.id, now);

    const notifications = await listNotificationsForTower(db, tower.id);
    const nudges = notifications.filter((n) => n.type === 'nudge');
    expect(nudges).toHaveLength(2);
    expect(count).toBe(2);

    const notifUserIds = new Set(nudges.map((n) => n.userId));
    const memberUserIds = new Set(s.members.map((m) => m.user.id));
    expect(notifUserIds).toEqual(memberUserIds);
  });

  it('skips member who already met quota', async () => {
    const s = await scenarios.towerRunningFor(5, { members: 2 });
    const tower = s.tower!;
    const period5 = s.periods.at(-1)!;
    const now = nudgeAt(tower, period5.periodStart);

    await recordEntry(db, {
      habitId: s.members[0]!.habit.id,
      localDate: period5.periodStart,
      loggedAt: SCENARIO_NOW,
      qualifies: true,
    });

    const count = await processNudge(db, period5.id, now);

    const notifications = await listNotificationsForTower(db, tower.id);
    const nudges = notifications.filter((n) => n.type === 'nudge');
    expect(nudges).toHaveLength(1);
    expect(nudges[0]!.userId).toBe(s.members[1]!.user.id);
    expect(count).toBe(1);
  });

  it('skips dormant member, sends to active member', async () => {
    const s = await scenarios.towerRunningFor(5, { members: 2 });
    const tower = s.tower!;
    const period5 = s.periods.at(-1)!;
    const now = nudgeAt(tower, period5.periodStart);

    await db
      .update(memberships)
      .set({
        state: 'dormant',
        dormancyReason: 'consecutive_miss',
        dormantSince: SCENARIO_NOW,
        consecutiveMissedPeriods: 2,
      })
      .where(eq(memberships.id, s.members[1]!.membership.id));

    const count = await processNudge(db, period5.id, now);

    const notifications = await listNotificationsForTower(db, tower.id);
    const nudges = notifications.filter((n) => n.type === 'nudge');
    expect(nudges).toHaveLength(1);
    expect(nudges[0]!.userId).toBe(s.members[0]!.user.id);
    expect(count).toBe(1);
  });

  it('produces no nudge when all members met quota', async () => {
    const s = await scenarios.towerRunningFor(5, { members: 2 });
    const tower = s.tower!;
    const period5 = s.periods.at(-1)!;
    const now = nudgeAt(tower, period5.periodStart);

    for (const m of s.members) {
      await recordEntry(db, {
        habitId: m.habit.id,
        localDate: period5.periodStart,
        loggedAt: SCENARIO_NOW,
        qualifies: true,
      });
    }

    const count = await processNudge(db, period5.id, now);

    const notifications = await listNotificationsForTower(db, tower.id);
    const nudges = notifications.filter((n) => n.type === 'nudge');
    expect(nudges).toHaveLength(0);
    expect(count).toBe(0);
  });

  it('staleness guard: no nudge when now is past deadline', async () => {
    const s = await scenarios.towerRunningFor(5);
    const tower = s.tower!;
    const period5 = s.periods.at(-1)!;
    const afterDeadline = new Date(deadlineAt(tower, period5.periodStart).getTime() + 60_000);

    const count = await processNudge(db, period5.id, afterDeadline);

    const notifications = await listNotificationsForTower(db, tower.id);
    expect(notifications).toHaveLength(0);
    expect(count).toBe(0);
  });

  it('no nudge when period is already evaluated', async () => {
    const s = await scenarios.towerRunningFor(5);
    const tower = s.tower!;
    const period5 = s.periods.at(-1)!;
    const evaluateAt = new Date('2026-10-28T07:00:00Z');

    await runTick(evaluateAt, {
      claim: (now) => claimDuePeriods(db, now),
      evaluate: createEvaluator(db, logger),
      logger,
    });

    const now = nudgeAt(tower, period5.periodStart);
    const count = await processNudge(db, period5.id, now);

    const notifications = await listNotificationsForTower(db, tower.id);
    const nudges = notifications.filter((n) => n.type === 'nudge');
    expect(nudges).toHaveLength(0);
    expect(count).toBe(0);
  });
});
