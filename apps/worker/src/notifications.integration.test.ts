import {
  claimDuePeriods,
  db,
  listNotificationsForTower,
  memberships,
  recordEntry,
  verifyTower,
} from '@tower-of-habit/db';
import { useScenarios, SCENARIO_NOW } from '@tower-of-habit/db/testing/vitest';
import { allMembersDormant, memberMissedPeriods } from '@tower-of-habit/shared/testing';
import { inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createWorkerEvaluator } from './evaluate.js';
import type { Logger } from './logger.js';
import { runTick } from './tick.js';

const noop = () => {};
const logger: Logger = { info: noop, warn: noop, error: noop };

const scenarios = useScenarios();

const AFTER_DAY5_EVALUATE_AT = new Date('2026-10-28T07:00:00Z');

describe('evaluation notification enqueueing', () => {
  it('survived evaluation produces no notifications', async () => {
    const s = await scenarios.towerRunningFor(5);
    const tower = s.tower!;
    const day5Date = s.periods.at(-1)!.periodStart;

    for (const m of s.members) {
      await recordEntry(db, {
        habitId: m.habit.id,
        localDate: day5Date,
        loggedAt: SCENARIO_NOW,
        qualifies: true,
      });
    }

    await runTick(AFTER_DAY5_EVALUATE_AT, {
      claim: (now) => claimDuePeriods(db, now),
      evaluate: createWorkerEvaluator(db, logger),
      logger,
    });

    const notifications = await listNotificationsForTower(db, tower.id);
    expect(notifications).toHaveLength(0);

    expect((await verifyTower(db, tower.id)).ok).toBe(true);
  });

  it('collapsed evaluation produces collapse notifications for all members', async () => {
    const s = await scenarios.towerRunningFor(5, { members: 2 });
    const tower = s.tower!;

    await runTick(AFTER_DAY5_EVALUATE_AT, {
      claim: (now) => claimDuePeriods(db, now),
      evaluate: createWorkerEvaluator(db, logger),
      logger,
    });

    const notifications = await listNotificationsForTower(db, tower.id);
    const collapseNotifs = notifications.filter((n) => n.type === 'collapse');
    expect(collapseNotifs).toHaveLength(2);

    const notifUserIds = new Set(collapseNotifs.map((n) => n.userId));
    const memberUserIds = new Set(s.members.map((m) => m.user.id));
    expect(notifUserIds).toEqual(memberUserIds);

    expect((await verifyTower(db, tower.id)).ok).toBe(true);
  });

  it('collapsed evaluation produces at_risk notification for newly at-risk member', async () => {
    const s = await scenarios.towerRunningFor(5, { members: 2 });
    const tower = s.tower!;
    const day5Date = s.periods.at(-1)!.periodStart;

    await recordEntry(db, {
      habitId: s.members[0]!.habit.id,
      localDate: day5Date,
      loggedAt: SCENARIO_NOW,
      qualifies: true,
    });

    await runTick(AFTER_DAY5_EVALUATE_AT, {
      claim: (now) => claimDuePeriods(db, now),
      evaluate: createWorkerEvaluator(db, logger),
      logger,
    });

    const notifications = await listNotificationsForTower(db, tower.id);
    const collapseNotifs = notifications.filter((n) => n.type === 'collapse');
    const atRiskNotifs = notifications.filter((n) => n.type === 'at_risk');

    expect(collapseNotifs).toHaveLength(2);
    expect(atRiskNotifs).toHaveLength(1);
    expect(atRiskNotifs[0]!.dedupeKey).toContain(s.members[1]!.membership.id);
    expect(notifications).toHaveLength(3);

    expect((await verifyTower(db, tower.id)).ok).toBe(true);
  });

  it('collapsed evaluation produces dormant notification for consecutive-miss member', async () => {
    const s = await scenarios.towerRunningFor(5, {
      members: 3,
      traits: [memberMissedPeriods(1, { member: 2 })],
    });
    const tower = s.tower!;
    const day5Date = s.periods.at(-1)!.periodStart;

    await recordEntry(db, {
      habitId: s.members[0]!.habit.id,
      localDate: day5Date,
      loggedAt: SCENARIO_NOW,
      qualifies: true,
    });

    await runTick(AFTER_DAY5_EVALUATE_AT, {
      claim: (now) => claimDuePeriods(db, now),
      evaluate: createWorkerEvaluator(db, logger),
      logger,
    });

    const notifications = await listNotificationsForTower(db, tower.id);
    const collapseNotifs = notifications.filter((n) => n.type === 'collapse');
    const atRiskNotifs = notifications.filter((n) => n.type === 'at_risk');
    const dormantNotifs = notifications.filter((n) => n.type === 'dormant');

    expect(collapseNotifs).toHaveLength(3);
    expect(atRiskNotifs).toHaveLength(1);
    expect(dormantNotifs).toHaveLength(1);
    expect(dormantNotifs[0]!.dedupeKey).toContain(s.members[2]!.membership.id);
    expect(notifications).toHaveLength(5);

    expect((await verifyTower(db, tower.id)).ok).toBe(true);
  });

  it('first hibernation produces hibernate notifications for all members', async () => {
    const s = await scenarios.towerRunningFor(5, { members: 2 });
    const tower = s.tower!;
    const now = AFTER_DAY5_EVALUATE_AT;

    const membershipIds = s.members.map((m) => m.membership.id);
    await db
      .update(memberships)
      .set({
        state: 'dormant',
        dormancyReason: 'consecutive_miss',
        dormantSince: SCENARIO_NOW,
        consecutiveMissedPeriods: 2,
      })
      .where(inArray(memberships.id, membershipIds));

    await runTick(now, {
      claim: (n) => claimDuePeriods(db, n),
      evaluate: createWorkerEvaluator(db, logger),
      logger,
    });

    const notifications = await listNotificationsForTower(db, tower.id);
    const hibernateNotifs = notifications.filter((n) => n.type === 'hibernate');
    expect(hibernateNotifs).toHaveLength(2);

    const notifUserIds = new Set(hibernateNotifs.map((n) => n.userId));
    const memberUserIds = new Set(s.members.map((m) => m.user.id));
    expect(notifUserIds).toEqual(memberUserIds);

    expect((await verifyTower(db, tower.id)).ok).toBe(true);
  });

  it('subsequent hibernation produces no notifications', async () => {
    const s = await scenarios.towerRunningFor(5, {
      members: 2,
      traits: [allMembersDormant()],
    });
    const tower = s.tower!;

    await runTick(AFTER_DAY5_EVALUATE_AT, {
      claim: (now) => claimDuePeriods(db, now),
      evaluate: createWorkerEvaluator(db, logger),
      logger,
    });

    const notifications = await listNotificationsForTower(db, tower.id);
    expect(notifications).toHaveLength(0);

    expect((await verifyTower(db, tower.id)).ok).toBe(true);
  });
});
