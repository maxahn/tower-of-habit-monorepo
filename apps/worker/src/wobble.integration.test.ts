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
import { runTick } from './tick.js';
import { processWobble } from './wobble.js';

const noop = () => {};
const logger: Logger = { info: noop, warn: noop, error: noop };

const scenarios = useScenarios();

function wobbleAt(tower: Parameters<typeof computePeriodWindow>[0], periodStart: string): Date {
  return new Date(computePeriodWindow(tower, periodStart).wobbleAt);
}

function deadlineAt(tower: Parameters<typeof computePeriodWindow>[0], periodStart: string): Date {
  return new Date(computePeriodWindow(tower, periodStart).deadlineAt);
}

describe('wobble dispatch', () => {
  it('broadcasts wobble to all members when all are outstanding', async () => {
    const s = await scenarios.towerRunningFor(5, { members: 2 });
    const tower = s.tower!;
    const period5 = s.periods.at(-1)!;
    const now = wobbleAt(tower, period5.periodStart);

    const count = await processWobble(db, period5.id, now);

    const notifications = await listNotificationsForTower(db, tower.id);
    const wobbles = notifications.filter((n) => n.type === 'wobble');
    expect(wobbles).toHaveLength(2);
    expect(count).toBe(2);

    const notifUserIds = new Set(wobbles.map((n) => n.userId));
    const memberUserIds = new Set(s.members.map((m) => m.user.id));
    expect(notifUserIds).toEqual(memberUserIds);
  });

  it('broadcasts wobble to all members even when only one is outstanding', async () => {
    const s = await scenarios.towerRunningFor(5, { members: 2 });
    const tower = s.tower!;
    const period5 = s.periods.at(-1)!;
    const now = wobbleAt(tower, period5.periodStart);

    await recordEntry(db, {
      habitId: s.members[0]!.habit.id,
      localDate: period5.periodStart,
      loggedAt: SCENARIO_NOW,
      qualifies: true,
    });

    const count = await processWobble(db, period5.id, now);

    const notifications = await listNotificationsForTower(db, tower.id);
    const wobbles = notifications.filter((n) => n.type === 'wobble');
    expect(wobbles).toHaveLength(2);
    expect(count).toBe(2);

    const notifUserIds = new Set(wobbles.map((n) => n.userId));
    const memberUserIds = new Set(s.members.map((m) => m.user.id));
    expect(notifUserIds).toEqual(memberUserIds);
  });

  it('excludes dormant members from broadcast', async () => {
    const s = await scenarios.towerRunningFor(5, { members: 3 });
    const tower = s.tower!;
    const period5 = s.periods.at(-1)!;
    const now = wobbleAt(tower, period5.periodStart);

    await db
      .update(memberships)
      .set({
        state: 'dormant',
        dormancyReason: 'consecutive_miss',
        dormantSince: SCENARIO_NOW,
        consecutiveMissedPeriods: 2,
      })
      .where(eq(memberships.id, s.members[2]!.membership.id));

    const count = await processWobble(db, period5.id, now);

    const notifications = await listNotificationsForTower(db, tower.id);
    const wobbles = notifications.filter((n) => n.type === 'wobble');
    expect(wobbles).toHaveLength(2);
    expect(count).toBe(2);

    const notifUserIds = new Set(wobbles.map((n) => n.userId));
    expect(notifUserIds).toContain(s.members[0]!.user.id);
    expect(notifUserIds).toContain(s.members[1]!.user.id);
    expect(notifUserIds).not.toContain(s.members[2]!.user.id);
  });

  it('produces no wobble when all members met quota', async () => {
    const s = await scenarios.towerRunningFor(5, { members: 2 });
    const tower = s.tower!;
    const period5 = s.periods.at(-1)!;
    const now = wobbleAt(tower, period5.periodStart);

    for (const m of s.members) {
      await recordEntry(db, {
        habitId: m.habit.id,
        localDate: period5.periodStart,
        loggedAt: SCENARIO_NOW,
        qualifies: true,
      });
    }

    const count = await processWobble(db, period5.id, now);

    const notifications = await listNotificationsForTower(db, tower.id);
    const wobbles = notifications.filter((n) => n.type === 'wobble');
    expect(wobbles).toHaveLength(0);
    expect(count).toBe(0);
  });

  it('staleness guard: no wobble when now is past deadline', async () => {
    const s = await scenarios.towerRunningFor(5);
    const tower = s.tower!;
    const period5 = s.periods.at(-1)!;
    const afterDeadline = new Date(deadlineAt(tower, period5.periodStart).getTime() + 60_000);

    const count = await processWobble(db, period5.id, afterDeadline);

    const notifications = await listNotificationsForTower(db, tower.id);
    expect(notifications).toHaveLength(0);
    expect(count).toBe(0);
  });

  it('no wobble when period is already evaluated', async () => {
    const s = await scenarios.towerRunningFor(5);
    const tower = s.tower!;
    const period5 = s.periods.at(-1)!;
    const evaluateAt = new Date('2026-10-28T07:00:00Z');

    await runTick(evaluateAt, {
      claim: (now) => claimDuePeriods(db, now),
      evaluate: createEvaluator(db, logger),
      logger,
    });

    const now = wobbleAt(tower, period5.periodStart);
    const count = await processWobble(db, period5.id, now);

    const notifications = await listNotificationsForTower(db, tower.id);
    const wobbles = notifications.filter((n) => n.type === 'wobble');
    expect(wobbles).toHaveLength(0);
    expect(count).toBe(0);
  });
});
