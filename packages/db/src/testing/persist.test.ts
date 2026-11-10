import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  allMembersDormant,
  factories,
  FACTORY_DEADLINE_TIME,
  memberMissedPeriods,
  membersLoggedToday,
} from '@tower-of-habit/shared/testing';
import { logEntry } from '../habits/entries/entries.js';
import { entries } from '../habits/entries/schema.js';
import { findTieredHabitsMissingBaseTier } from '../habits/tiers/tiers.js';
import { users } from '../schema.js';
import { db } from '../test-utils.js';
import { findOrdinalGaps } from '../towers/blocks/blocks.js';
import { DEFAULT_DEADLINE_TIME, towers } from '../towers/schema.js';
import { useScenarios } from './vitest.js';

const scenarios = useScenarios();

describe('persisted scenarios', () => {
  it('the 1.11 done-when, in one line', async () => {
    const s = await scenarios.towerRunningFor(12, { members: 3, traits: [memberMissedPeriods(1)] });

    expect(s.tower).toMatchObject({ lifecycle: 'active', height: 0, currentStreak: 0 });
    expect(s.periods).toHaveLength(12);
    expect(s.periods.filter((p) => p.state === 'evaluated')).toHaveLength(11);
    expect(s.periods.at(-2)!.outcome).toBe('collapsed');
    expect(s.members.map((m) => m.membership.state)).toEqual(['active', 'active', 'at_risk']);
    expect(s.blocks).toEqual([expect.objectContaining({ ordinal: 1, blockHeight: 10 })]);
  });

  it('round-trips a long healthy tower', async () => {
    const s = await scenarios.towerRunningFor(30, { members: 2 });
    const [row] = await db.select().from(towers).where(eq(towers.id, s.tower!.id));
    expect(row).toMatchObject({ height: 29, currentStreak: 29 });
    expect(s.entries).toHaveLength(58);
  });

  it('round-trips dormancy, and the database accepts the dormancy fields', async () => {
    const s = await scenarios.towerRunningFor(10, { members: 2, traits: [allMembersDormant()] });
    expect(s.members.map((m) => m.membership)).toEqual([
      expect.objectContaining({ state: 'dormant', dormancyReason: 'consecutive_miss' }),
      expect.objectContaining({ state: 'dormant', dormancyReason: 'consecutive_miss' }),
    ]);
    expect(s.periods.at(-2)!.outcome).toBe('hibernated');
  });

  it('stacks base blocks with gapless ordinals, through appendBaseBlock', async () => {
    const s = await scenarios.towerWithBaseBlocks(3, { members: 2 });
    expect(s.blocks.map((b) => b.ordinal)).toEqual([1, 2, 3]);
    expect(await findOrdinalGaps(db)).not.toContain(s.tower!.id);
  });

  it('persists tiered habits with their base tier', async () => {
    const s = await scenarios.towerRunningFor(3, { habitType: 'tiered' });
    expect(await findTieredHabitsMissingBaseTier(db)).not.toContain(s.habits[0]!.id);
  });

  it('persists a standalone habit with no tower', async () => {
    const s = await scenarios.standaloneHabit({ type: 'numeric', loggedDays: 4 });
    expect(s.tower).toBeNull();
    expect(s.entries).toHaveLength(4);
  });

  it('shares users across plans', async () => {
    const f = factories({ seed: Date.UTC(2026, 0, 1), now: scenarios.now });
    const people = [f.makeUser(), f.makeUser()];
    const a = await scenarios.towerRunningFor(3, { members: people });
    const b = await scenarios.towerWithBaseBlocks(1, { members: people });
    expect(a.members.map((m) => m.user.id)).toEqual(b.members.map((m) => m.user.id));
    expect(a.tower!.id).not.toBe(b.tower!.id);
  });
});

// Factories write local_date themselves. These keep them honest against the
// real resolver: replaying a plan's loggedAt through logEntry must land on the
// same dates.
describe('plan dates agree with logEntry', () => {
  async function replay(
    habitId: string,
    planned: { localDate: string; loggedAt: Date }[],
    timezone?: string
  ) {
    await db.delete(entries).where(eq(entries.habitId, habitId));
    const resolved: string[] = [];
    for (const e of [...planned].sort((x, y) => x.loggedAt.getTime() - y.loggedAt.getTime())) {
      const row = await logEntry(db, {
        habitId,
        loggedAt: e.loggedAt,
        ...(timezone ? { timezone } : {}),
      });
      resolved.push(row.localDate);
    }
    return resolved;
  }

  it.each(['22:00', '23:30', '07:00'])('for a tower with a %s deadline', async (deadline) => {
    const now = deadline === '07:00' ? new Date('2026-10-27T12:00:00Z') : scenarios.now;
    const s = await scenarios.towerRunningFor(6, {
      now,
      deadline,
      traits: [membersLoggedToday()],
    });
    const planned = s.plan.entries.filter((e) => e.habitId === s.habits[0]!.id);
    expect(await replay(s.habits[0]!.id, planned)).toEqual(planned.map((e) => e.localDate));
  });

  it('for a standalone habit in a reported zone', async () => {
    const s = await scenarios.standaloneHabit({ timezone: 'Asia/Kolkata', loggedDays: 5 });
    const planned = s.plan.entries;
    expect(await replay(s.habits[0]!.id, planned, 'Asia/Kolkata')).toEqual(
      planned.map((e) => e.localDate)
    );
  });
});

describe('useScenarios cleanup', () => {
  let created: { towerId: string; userIds: string[] } | undefined;

  it('creates rows', async () => {
    const s = await scenarios.towerWithBaseBlocks(1, { members: 2 });
    created = { towerId: s.tower!.id, userIds: s.users.map((u) => u.id) };
  });

  it('leaves none behind after the test', async () => {
    expect(await db.select().from(towers).where(eq(towers.id, created!.towerId))).toEqual([]);
    expect(await db.select().from(users).where(inArray(users.id, created!.userIds))).toEqual([]);
  });
});

it('FACTORY_DEADLINE_TIME matches DEFAULT_DEADLINE_TIME', () => {
  expect(FACTORY_DEADLINE_TIME).toBe(DEFAULT_DEADLINE_TIME);
});
