import {
  activateTower,
  claimDuePeriods,
  createHabit,
  createMembership,
  createTowerWithFreshCode,
  createUser,
  db,
  ensurePeriod,
  getMembership,
  getPeriodForDate,
  getTower,
  listBaseBlocksForTower,
  listNotificationsForTower,
  listPeriodsForTower,
  recordEntry,
  towers,
  transitionMembership,
  updateMembership,
  users,
  verifyTower,
} from '@tower-of-habit/db';
import {
  addDays,
  civilInZone,
  computePeriodWindow,
  resolvePeriodWindow,
} from '@tower-of-habit/shared';
import { inArray } from 'drizzle-orm';
import { runMigrations } from 'graphile-worker';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createWorkerEvaluator } from './evaluate.js';
import type { Logger } from './logger.js';
import { processNudge } from './nudge.js';
import { materialisePeriods } from './sweep.js';
import { runTick } from './tick.js';
import { processWobble } from './wobble.js';

const noop = () => {};
const logger: Logger = { info: noop, warn: noop, error: noop };

const TZ = 'America/Edmonton';
const DAY1 = '2026-09-23';

const TOWER_CONFIG = {
  periodUnit: 'day' as const,
  periodLength: 1,
  quota: 1,
  timezone: TZ,
  deadlineTime: '22:00',
  graceWindowMinutes: 120,
  nudgeLeadMinutes: 300,
  wobbleLeadMinutes: 180,
  weekResetDay: null,
};

function dayDate(n: number): string {
  return addDays(DAY1, n - 1);
}

function toEdmonton(date: string, time: string): Date {
  const [h, m] = time.split(':').map(Number);
  const naive = new Date(`${date}T${time}:00Z`);
  const civil = civilInZone(naive, TZ);
  const diff = h! * 60 + m! - civil.minutesIntoDay;
  return new Date(naive.getTime() + diff * 60_000);
}

function noonOf(date: string): Date {
  return toEdmonton(date, '12:00');
}

function graceOf(date: string): Date {
  return toEdmonton(date, '23:00');
}

beforeAll(async () => {
  await runMigrations({ connectionString: process.env.DATABASE_URL! });
});

describe('40-day timeline', () => {
  const towerIds: string[] = [];
  const userIds: string[] = [];

  afterEach(async () => {
    if (towerIds.length) await db.delete(towers).where(inArray(towers.id, towerIds));
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
    towerIds.length = 0;
    userIds.length = 0;
  });

  it('drives 40 days through survivals, collapses, dormancy, voluntary absence, hibernation, wake, and DST', async () => {
    // --- Setup ---
    const userA = await createUser(db, { email: `tt-a-${Date.now()}@test.local`, timezone: TZ });
    const userB = await createUser(db, { email: `tt-b-${Date.now()}@test.local`, timezone: TZ });
    const userC = await createUser(db, { email: `tt-c-${Date.now()}@test.local`, timezone: TZ });
    userIds.push(userA.id, userB.id, userC.id);

    const habitA = await createHabit(db, {
      ownerId: userA.id,
      name: 'A',
      type: 'binary',
      periodUnit: 'day',
      periodLength: 1,
      quota: 1,
    });
    const habitB = await createHabit(db, {
      ownerId: userB.id,
      name: 'B',
      type: 'binary',
      periodUnit: 'day',
      periodLength: 1,
      quota: 1,
    });
    const habitC = await createHabit(db, {
      ownerId: userC.id,
      name: 'C',
      type: 'binary',
      periodUnit: 'day',
      periodLength: 1,
      quota: 1,
    });

    const tower = await createTowerWithFreshCode(db, {
      ...TOWER_CONFIG,
      hostId: userA.id,
      name: 'Time Travel Tower',
    });
    towerIds.push(tower.id);

    const activateTime = noonOf(DAY1);
    const memA = await createMembership(db, {
      towerId: tower.id,
      userId: userA.id,
      habitId: habitA.id,
      joinedAt: activateTime,
    });
    const memB = await createMembership(db, {
      towerId: tower.id,
      userId: userB.id,
      habitId: habitB.id,
      joinedAt: activateTime,
    });
    const memC = await createMembership(db, {
      towerId: tower.id,
      userId: userC.id,
      habitId: habitC.id,
      joinedAt: activateTime,
    });

    await activateTower(db, tower.id, activateTime);

    // Create first period using resolvePeriodWindow
    const activatedTower = (await getTower(db, tower.id))!;
    const anchorDate = civilInZone(activatedTower.startedAt!, TZ).date;
    const firstWindow = resolvePeriodWindow({
      periodUnit: 'day',
      periodLength: 1,
      weekResetDay: null,
      anchorDate,
      on: DAY1,
      deadlineTime: '22:00',
      timeZone: TZ,
      graceMinutes: 120,
    });
    await ensurePeriod(db, {
      towerId: tower.id,
      periodStart: firstWindow.periodStart,
      periodEnd: firstWindow.periodEnd,
      deadlineAt: firstWindow.deadlineAt,
      evaluateAt: firstWindow.evaluateAt,
    });

    // Helper: log a qualifying entry and update lastQualifyingDate on the membership
    // (the API route handler does this; recordEntry alone doesn't)
    const habitToMembership = new Map([
      [habitA.id, memA.id],
      [habitB.id, memB.id],
      [habitC.id, memC.id],
    ]);
    async function logEntry(habitId: string, date: string, loggedAt?: Date) {
      await recordEntry(db, {
        habitId,
        localDate: date,
        loggedAt: loggedAt ?? noonOf(date),
        qualifies: true,
      });
      const membershipId = habitToMembership.get(habitId)!;
      await updateMembership(db, membershipId, { lastQualifyingDate: date });
    }

    // Helper: get the pending period for a date, or the current pending one
    async function pendingPeriod(date: string) {
      const p = await getPeriodForDate(db, tower.id, date);
      expect(p).toBeDefined();
      return p!;
    }

    // Helper: tick = materialise + claim + evaluate
    async function tick(now: Date) {
      const report = await runTick(now, {
        materialise: (n) => materialisePeriods(db, n, logger),
        claim: (n) => claimDuePeriods(db, n),
        evaluate: createWorkerEvaluator(db, logger),
        logger,
      });
      expect(report.errored).toBe(0);
      expect(report.evaluated).toBeGreaterThanOrEqual(1);
    }

    // Helper: assert tower state
    async function assertState(height: number, streak: number) {
      const t = await getTower(db, tower.id);
      expect(t!.height).toBe(height);
      expect(t!.currentStreak).toBe(streak);
      expect((await verifyTower(db, tower.id)).ok).toBe(true);
    }

    // Helper: assert notification count
    async function assertNotifCount(expected: number) {
      const notifs = await listNotificationsForTower(db, tower.id, 500);
      expect(notifs).toHaveLength(expected);
    }

    // ==================== Days 1–3: everyone logs → survived ×3 ====================
    for (let day = 1; day <= 3; day++) {
      const date = dayDate(day);
      await logEntry(habitA.id, date);
      await logEntry(habitB.id, date);
      await logEntry(habitC.id, date);

      const period = await pendingPeriod(date);
      await tick(new Date(period.evaluateAt.getTime() + 60_000));
      await assertState(day, day);
      await assertNotifCount(0);
    }

    // ==================== Day 4: nudge, wobble, grace-window save → survived ====================
    {
      const date = dayDate(4);
      await logEntry(habitA.id, date);
      await logEntry(habitB.id, date);
      // C does NOT log yet

      const period = await pendingPeriod(date);

      // Compute nudge and wobble times from the period schedule
      const schedule = computePeriodWindow(TOWER_CONFIG, date);
      const nudgeAt = new Date(schedule.nudgeAt);
      const wobbleAt = new Date(schedule.wobbleAt);

      // processNudge: C is the only one who hasn't logged
      const nudgeCount = await processNudge(db, period.id, nudgeAt);
      expect(nudgeCount).toBe(1);
      await assertNotifCount(1);

      // Verify nudge is for C
      const notifsAfterNudge = await listNotificationsForTower(db, tower.id, 500);
      expect(notifsAfterNudge[0]!.type).toBe('nudge');
      expect(notifsAfterNudge[0]!.userId).toBe(userC.id);

      // processWobble: anyone outstanding → wobble to ALL live members
      const wobbleCount = await processWobble(db, period.id, wobbleAt);
      expect(wobbleCount).toBe(3);
      await assertNotifCount(4);

      // Verify wobbles
      const notifsAfterWobble = await listNotificationsForTower(db, tower.id, 500);
      const wobbles = notifsAfterWobble.filter((n) => n.type === 'wobble');
      expect(wobbles).toHaveLength(3);
      const wobbleUserIds = new Set(wobbles.map((n) => n.userId));
      expect(wobbleUserIds).toEqual(new Set([userA.id, userB.id, userC.id]));

      // C logs at 23:00 (inside grace window)
      await logEntry(habitC.id, date, graceOf(date));

      // Evaluate → survived
      await tick(new Date(period.evaluateAt.getTime() + 60_000));
      await assertState(4, 4);
      await assertNotifCount(4); // survived adds nothing
    }

    // ==================== Day 5: C misses → collapsed + base block ====================
    {
      const date = dayDate(5);
      await logEntry(habitA.id, date);
      await logEntry(habitB.id, date);
      // C does NOT log

      const period = await pendingPeriod(date);
      await tick(new Date(period.evaluateAt.getTime() + 60_000));
      await assertState(0, 0); // height resets on collapse

      // Notifications: 3 collapse + 1 at_risk (C)
      await assertNotifCount(8);
      const notifs = await listNotificationsForTower(db, tower.id, 500);
      const collapseNotifs = notifs.filter((n) => n.type === 'collapse');
      const atRiskNotifs = notifs.filter((n) => n.type === 'at_risk');
      expect(collapseNotifs).toHaveLength(3);
      expect(atRiskNotifs).toHaveLength(1);
      expect(atRiskNotifs[0]!.userId).toBe(userC.id);

      // Base block: 1 block, ordinal=1, blockHeight=4
      const blocks = await listBaseBlocksForTower(db, tower.id);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.ordinal).toBe(1);
      expect(blocks[0]!.blockHeight).toBe(4);
      expect(blocks[0]!.runStartDate).toBe(dayDate(1));
      expect(blocks[0]!.runEndDate).toBe(dayDate(4));
    }

    // ==================== Day 6: C misses again → survived (C → dormant) ====================
    {
      const date = dayDate(6);
      await logEntry(habitA.id, date);
      await logEntry(habitB.id, date);

      const period = await pendingPeriod(date);
      await tick(new Date(period.evaluateAt.getTime() + 60_000));
      await assertState(1, 1);
      await assertNotifCount(8); // survived = no new notifications
    }

    // ==================== Days 7–20: A and B log, C dormant → survived ×14 ====================
    for (let day = 7; day <= 20; day++) {
      const date = dayDate(day);
      await logEntry(habitA.id, date);
      await logEntry(habitB.id, date);

      const period = await pendingPeriod(date);
      await tick(new Date(period.evaluateAt.getTime() + 60_000));
      await assertState(day - 5, day - 5);
      await assertNotifCount(8);
    }

    // ==================== Day 21: B declares voluntary absence → survived ====================
    {
      const date = dayDate(21);
      await logEntry(habitA.id, date);

      // B declares absence for days 21–24
      await transitionMembership(db, memB.id, { to: 'dormant', reason: 'voluntary' }, noonOf(date));
      await updateMembership(db, memB.id, {
        voluntaryReturnDate: dayDate(25),
        voluntaryAbsenceDaysUsed: 4,
      });

      const period = await pendingPeriod(date);
      await tick(new Date(period.evaluateAt.getTime() + 60_000));
      await assertState(16, 16);
      await assertNotifCount(8);
    }

    // ==================== Days 22–24: A logs, B+C dormant → survived ×3 ====================
    for (let day = 22; day <= 24; day++) {
      const date = dayDate(day);
      await logEntry(habitA.id, date);

      const period = await pendingPeriod(date);
      await tick(new Date(period.evaluateAt.getTime() + 60_000));
      await assertState(day - 5, day - 5);
      await assertNotifCount(8);
    }

    // ==================== Day 25: B's return date reached, B logs → survived ====================
    {
      const date = dayDate(25);
      await logEntry(habitA.id, date);
      await logEntry(habitB.id, date);

      const period = await pendingPeriod(date);
      await tick(new Date(period.evaluateAt.getTime() + 60_000));
      await assertState(20, 20);
      await assertNotifCount(8);

      // B should be active again (day_elapsed trigger returned them)
      const bState = await getMembership(db, memB.id);
      expect(bState!.state).toBe('active');
    }

    // ==================== Day 26: C logs → survived (C returns to active) ====================
    {
      const date = dayDate(26);
      // C logs a qualifying entry and returns from dormancy
      await logEntry(habitC.id, date);
      await transitionMembership(db, memC.id, { to: 'active' }, noonOf(date));

      await logEntry(habitA.id, date);
      await logEntry(habitB.id, date);

      const period = await pendingPeriod(date);
      await tick(new Date(period.evaluateAt.getTime() + 60_000));
      await assertState(21, 21);
      await assertNotifCount(8);
    }

    // ==================== Days 27–29: all three log → survived ×3 ====================
    for (let day = 27; day <= 29; day++) {
      const date = dayDate(day);
      await logEntry(habitA.id, date);
      await logEntry(habitB.id, date);
      await logEntry(habitC.id, date);

      const period = await pendingPeriod(date);
      await tick(new Date(period.evaluateAt.getTime() + 60_000));
      await assertState(day - 5, day - 5);
      await assertNotifCount(8);
    }

    // ==================== Day 30: nobody logs → collapsed + base block ====================
    {
      const date = dayDate(30);
      const period = await pendingPeriod(date);
      await tick(new Date(period.evaluateAt.getTime() + 60_000));
      await assertState(0, 0);

      // Notifications: 3 collapse + 3 at_risk (A, B, C all active, all first miss)
      await assertNotifCount(14);
      const notifs = await listNotificationsForTower(db, tower.id, 500);
      const collapseNotifs = notifs.filter((n) => n.type === 'collapse');
      const atRiskNotifs = notifs.filter((n) => n.type === 'at_risk');
      expect(collapseNotifs).toHaveLength(6); // 3 from day 5 + 3 from day 30
      expect(atRiskNotifs).toHaveLength(4); // 1 from day 5 (C) + 3 from day 30 (A, B, C)

      // Base block 2: ordinal=2, blockHeight=24
      const blocks = await listBaseBlocksForTower(db, tower.id);
      expect(blocks).toHaveLength(2);
      expect(blocks[1]!.ordinal).toBe(2);
      expect(blocks[1]!.blockHeight).toBe(24);
      expect(blocks[1]!.runStartDate).toBe(dayDate(6));
      expect(blocks[1]!.runEndDate).toBe(dayDate(29));
    }

    // ==================== Day 31: nobody logs → survived (at_risk→dormant, no collapse) ====================
    // A, B are at_risk (counted/live). Both short → dormant (collapses=false). Outcome = survived.
    {
      const date = dayDate(31);
      const period = await pendingPeriod(date);
      await tick(new Date(period.evaluateAt.getTime() + 60_000));
      await assertState(1, 1); // extendTowerRun: 0+1
      await assertNotifCount(14); // survived = no new notifications
    }

    // ==================== Day 32: all dormant → hibernated (first hibernation) ====================
    {
      const date = dayDate(32);
      const period = await pendingPeriod(date);
      await tick(new Date(period.evaluateAt.getTime() + 60_000));
      await assertState(1, 1); // hibernated = height unchanged

      await assertNotifCount(17); // 3 hibernate notifications (first hibernation)
      const notifs = await listNotificationsForTower(db, tower.id, 500);
      const hibernateNotifs = notifs.filter((n) => n.type === 'hibernate');
      expect(hibernateNotifs).toHaveLength(3);
    }

    // ==================== Days 33–38: nobody logs, all dormant → hibernated ×6 ====================
    for (let day = 33; day <= 38; day++) {
      const date = dayDate(day);
      const period = await pendingPeriod(date);
      await tick(new Date(period.evaluateAt.getTime() + 60_000));
      await assertState(1, 1); // height unchanged through hibernation
      await assertNotifCount(17); // subsequent hibernation = no new notifications
    }

    // ==================== Day 39: A logs alone → survived ====================
    {
      const date = dayDate(39);
      await logEntry(habitA.id, date);
      await transitionMembership(db, memA.id, { to: 'active' }, noonOf(date));

      const period = await pendingPeriod(date);
      await tick(new Date(period.evaluateAt.getTime() + 60_000));
      await assertState(2, 2); // extendTowerRun: 1+1
      await assertNotifCount(17);
    }

    // ==================== Day 40: DST transition → survived ====================
    {
      const date = dayDate(40); // Nov 1, 2026 — DST fall-back
      expect(date).toBe('2026-11-01');

      await logEntry(habitA.id, date);

      const period = await pendingPeriod(date);
      await tick(new Date(period.evaluateAt.getTime() + 60_000));
      await assertState(3, 3); // extendTowerRun: 2+1
      await assertNotifCount(17);

      // DST verification: compare evaluateAt between day 39 and day 40
      const day39Period = await getPeriodForDate(db, tower.id, dayDate(39));
      const day40Period = await getPeriodForDate(db, tower.id, dayDate(40));
      expect(day39Period).toBeDefined();
      expect(day40Period).toBeDefined();
      // Day 39 (Oct 31) is MDT (UTC-6): midnight = 06:00 UTC
      // Day 40 (Nov 1) is MST (UTC-7): midnight = 07:00 UTC
      const diff = day40Period!.evaluateAt.getTime() - day39Period!.evaluateAt.getTime();
      // 1 hour later in UTC (25h between evaluations instead of 24h)
      expect(diff).toBe(25 * 3600_000);
    }

    // ==================== Final assertions ====================
    expect((await verifyTower(db, tower.id)).ok).toBe(true);

    // Cumulative height: sum(block_heights) + towers.height
    const blocks = await listBaseBlocksForTower(db, tower.id);
    const sumBlockHeights = blocks.reduce((s, b) => s + b.blockHeight, 0);
    const finalTower = (await getTower(db, tower.id))!;
    expect(sumBlockHeights + finalTower.height).toBe(31);

    // Exact notification count
    const allNotifications = await listNotificationsForTower(db, tower.id, 500);
    expect(allNotifications).toHaveLength(17);

    // All 40 periods evaluated
    const allPeriods = await listPeriodsForTower(db, tower.id, 50);
    expect(allPeriods).toHaveLength(41); // 40 evaluated + 1 pending (next day)
    const evaluated = allPeriods.filter((p) => p.state === 'evaluated');
    expect(evaluated).toHaveLength(40);
  }, 60_000);
});

describe('sub-minimum run', () => {
  const towerIds: string[] = [];
  const userIds: string[] = [];

  afterEach(async () => {
    if (towerIds.length) await db.delete(towers).where(inArray(towers.id, towerIds));
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
    towerIds.length = 0;
    userIds.length = 0;
  });

  it('a 2-day run produces no block; a 10-day run produces ordinal=1 with gap=2', async () => {
    // --- Setup ---
    const userX = await createUser(db, { email: `tt-x-${Date.now()}@test.local`, timezone: TZ });
    const userY = await createUser(db, { email: `tt-y-${Date.now()}@test.local`, timezone: TZ });
    userIds.push(userX.id, userY.id);

    const habitX = await createHabit(db, {
      ownerId: userX.id,
      name: 'X',
      type: 'binary',
      periodUnit: 'day',
      periodLength: 1,
      quota: 1,
    });
    const habitY = await createHabit(db, {
      ownerId: userY.id,
      name: 'Y',
      type: 'binary',
      periodUnit: 'day',
      periodLength: 1,
      quota: 1,
    });

    const tower = await createTowerWithFreshCode(db, {
      ...TOWER_CONFIG,
      hostId: userX.id,
      name: 'Sub-minimum Tower',
    });
    towerIds.push(tower.id);

    const activateTime = noonOf(DAY1);
    await createMembership(db, {
      towerId: tower.id,
      userId: userX.id,
      habitId: habitX.id,
      joinedAt: activateTime,
    });
    await createMembership(db, {
      towerId: tower.id,
      userId: userY.id,
      habitId: habitY.id,
      joinedAt: activateTime,
    });

    await activateTower(db, tower.id, activateTime);

    const activatedTower = (await getTower(db, tower.id))!;
    const anchorDate = civilInZone(activatedTower.startedAt!, TZ).date;
    const firstWindow = resolvePeriodWindow({
      periodUnit: 'day',
      periodLength: 1,
      weekResetDay: null,
      anchorDate,
      on: DAY1,
      deadlineTime: '22:00',
      timeZone: TZ,
      graceMinutes: 120,
    });
    await ensurePeriod(db, {
      towerId: tower.id,
      periodStart: firstWindow.periodStart,
      periodEnd: firstWindow.periodEnd,
      deadlineAt: firstWindow.deadlineAt,
      evaluateAt: firstWindow.evaluateAt,
    });

    async function logEntry(habitId: string, date: string) {
      await recordEntry(db, {
        habitId,
        localDate: date,
        loggedAt: noonOf(date),
        qualifies: true,
      });
    }

    async function pendingPeriod(date: string) {
      const p = await getPeriodForDate(db, tower.id, date);
      expect(p).toBeDefined();
      return p!;
    }

    async function tick(now: Date) {
      await runTick(now, {
        materialise: (n) => materialisePeriods(db, n, logger),
        claim: (n) => claimDuePeriods(db, n),
        evaluate: createWorkerEvaluator(db, logger),
        logger,
      });
    }

    // Days 1–2: both log → survived ×2
    for (let day = 1; day <= 2; day++) {
      const date = dayDate(day);
      await logEntry(habitX.id, date);
      await logEntry(habitY.id, date);
      const period = await pendingPeriod(date);
      await tick(new Date(period.evaluateAt.getTime() + 60_000));
    }

    // Verify height=2
    let t = (await getTower(db, tower.id))!;
    expect(t.height).toBe(2);

    // Day 3: nobody logs → collapsed
    {
      const date = dayDate(3);
      const period = await pendingPeriod(date);
      await tick(new Date(period.evaluateAt.getTime() + 60_000));

      t = (await getTower(db, tower.id))!;
      expect(t.height).toBe(0);

      // No base block (height 2 < MIN_BLOCK_DAYS 3)
      const blocks = await listBaseBlocksForTower(db, tower.id);
      expect(blocks).toHaveLength(0);
    }

    // Day 4: both are at_risk from day 3 collapse, they log → survived
    // But first they transition to active after the collapse made them at_risk
    // The at_risk→active transition happens inside evaluation when they meet quota

    // Days 4–13: both log → survived ×10
    for (let day = 4; day <= 13; day++) {
      const date = dayDate(day);
      await logEntry(habitX.id, date);
      await logEntry(habitY.id, date);
      const period = await pendingPeriod(date);
      await tick(new Date(period.evaluateAt.getTime() + 60_000));
    }

    t = (await getTower(db, tower.id))!;
    expect(t.height).toBe(10);

    // Day 14: nobody logs → collapsed
    {
      const date = dayDate(14);
      const period = await pendingPeriod(date);
      await tick(new Date(period.evaluateAt.getTime() + 60_000));

      t = (await getTower(db, tower.id))!;
      expect(t.height).toBe(0);
      expect(t.currentStreak).toBe(0);

      // 1 block: the sub-minimum 2-day run produced nothing
      const blocks = await listBaseBlocksForTower(db, tower.id);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.ordinal).toBe(1);
      expect(blocks[0]!.blockHeight).toBe(10);
      expect(blocks[0]!.runStartDate).toBe(dayDate(4));
      expect(blocks[0]!.runEndDate).toBe(dayDate(13));
    }

    // Survived periods = 12 (days 1,2 + days 4-13)
    const allPeriods = await listPeriodsForTower(db, tower.id, 50);
    const survived = allPeriods.filter((p) => p.outcome === 'survived');
    expect(survived).toHaveLength(12);

    // Gap = survived - sum(blockHeights) = 12 - 10 = 2
    const blocks = await listBaseBlocksForTower(db, tower.id);
    const sumBlockHeights = blocks.reduce((s, b) => s + b.blockHeight, 0);
    expect(sumBlockHeights + t.currentStreak).toBe(10);
    expect(survived.length - sumBlockHeights).toBe(2);

    expect((await verifyTower(db, tower.id)).ok).toBe(true);
  }, 30_000);
});
