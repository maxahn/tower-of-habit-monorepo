import { db, getMembership, listNotificationsForTower, memberships } from '@tower-of-habit/db';
import { SCENARIO_NOW, useScenarios } from '@tower-of-habit/db/testing/vitest';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { sweepBackstop } from './backstop.js';

const scenarios = useScenarios();

describe('backstop sweep', () => {
  it('transitions never-logged member to dormant after 15 days since join', async () => {
    const s = await scenarios.towerRunningFor(5, { members: 2 });
    const member1 = s.members[1]!;

    const fifteenDaysAgo = new Date('2026-10-12T18:00:00Z');
    await db
      .update(memberships)
      .set({ lastQualifyingDate: null, joinedAt: fifteenDaysAgo })
      .where(eq(memberships.id, member1.membership.id));

    const count = await sweepBackstop(db, SCENARIO_NOW);

    const updated = await getMembership(db, member1.membership.id);
    expect(updated!.state).toBe('dormant');
    expect(updated!.dormancyReason).toBe('backstop');
    expect(count).toBe(1);

    const m0 = await getMembership(db, s.members[0]!.membership.id);
    expect(m0!.state).toBe('active');
  });

  it('transitions member when lastQualifyingDate is exactly 14 days ago', async () => {
    const s = await scenarios.towerRunningFor(5, { members: 2 });
    const member1 = s.members[1]!;

    await db
      .update(memberships)
      .set({ lastQualifyingDate: '2026-10-13' })
      .where(eq(memberships.id, member1.membership.id));

    const count = await sweepBackstop(db, SCENARIO_NOW);

    const updated = await getMembership(db, member1.membership.id);
    expect(updated!.state).toBe('dormant');
    expect(updated!.dormancyReason).toBe('backstop');
    expect(count).toBe(1);
  });

  it('enqueues dormant notification for each transitioned member', async () => {
    const s = await scenarios.towerRunningFor(5, { members: 3 });

    for (const m of [s.members[1]!, s.members[2]!]) {
      await db
        .update(memberships)
        .set({ lastQualifyingDate: '2026-10-12' })
        .where(eq(memberships.id, m.membership.id));
    }

    const count = await sweepBackstop(db, SCENARIO_NOW);

    const notifications = await listNotificationsForTower(db, s.tower!.id);
    const dormantNotifs = notifications.filter((n) => n.type === 'dormant');
    expect(dormantNotifs).toHaveLength(2);
    expect(count).toBe(2);

    const notifUserIds = new Set(dormantNotifs.map((n) => n.userId));
    expect(notifUserIds).toContain(s.members[1]!.user.id);
    expect(notifUserIds).toContain(s.members[2]!.user.id);
  });

  it('leaves member unchanged when logged within 14 days', async () => {
    const s = await scenarios.towerRunningFor(5, { members: 2 });

    const count = await sweepBackstop(db, SCENARIO_NOW);

    const notifications = await listNotificationsForTower(db, s.tower!.id);
    expect(notifications).toHaveLength(0);
    expect(count).toBe(0);

    for (const m of s.members) {
      const membership = await getMembership(db, m.membership.id);
      expect(membership!.state).toBe('active');
    }
  });

  it('skips already dormant member', async () => {
    const s = await scenarios.towerRunningFor(5, { members: 2 });

    await db
      .update(memberships)
      .set({
        state: 'dormant',
        dormancyReason: 'consecutive_miss',
        dormantSince: SCENARIO_NOW,
        consecutiveMissedPeriods: 2,
      })
      .where(eq(memberships.id, s.members[1]!.membership.id));

    const count = await sweepBackstop(db, SCENARIO_NOW);

    const notifications = await listNotificationsForTower(db, s.tower!.id);
    expect(notifications).toHaveLength(0);
    expect(count).toBe(0);
  });

  it('leaves member unchanged at day 13', async () => {
    const s = await scenarios.towerRunningFor(5, { members: 2 });

    await db
      .update(memberships)
      .set({ lastQualifyingDate: '2026-10-14' })
      .where(eq(memberships.id, s.members[1]!.membership.id));

    const count = await sweepBackstop(db, SCENARIO_NOW);

    const updated = await getMembership(db, s.members[1]!.membership.id);
    expect(updated!.state).toBe('active');
    expect(count).toBe(0);

    const notifications = await listNotificationsForTower(db, s.tower!.id);
    expect(notifications).toHaveLength(0);
  });
});
