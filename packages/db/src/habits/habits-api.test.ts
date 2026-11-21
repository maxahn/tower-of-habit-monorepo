import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, useTestOwner } from '../test-utils.js';
import { useScenarios } from '../testing/vitest.js';
import { createMembership } from '../towers/memberships/memberships.js';
import { towers } from '../towers/schema.js';
import { createTower } from '../towers/towers.js';
import { createHabit, findHabitTower, listHabitsForOwner } from './habits.js';
import { listTiers, replaceTiers } from './tiers/tiers.js';

/*
 * 2.12: the reads and writes behind the habit endpoints.
 */

const owner = useTestOwner();
const scenarios = useScenarios();

describe('listHabitsForOwner', () => {
  it("returns the owner's habits, oldest first, and nobody else's", async () => {
    const a = await createHabit(db, { ownerId: owner(), name: 'A', type: 'binary' });
    const b = await createHabit(db, { ownerId: owner(), name: 'B', type: 'binary' });
    const s = await scenarios.standaloneHabit();
    expect((await listHabitsForOwner(db, owner())).map((h) => h.id)).toEqual([a.id, b.id]);
    expect((await listHabitsForOwner(db, s.users[0]!.id)).map((h) => h.id)).toEqual([
      s.habits[0]!.id,
    ]);
  });
});

describe('replaceTiers', () => {
  it('replaces the ladder wholesale, in one transaction', async () => {
    const h = await createHabit(db, {
      ownerId: owner(),
      name: 'Laps',
      type: 'tiered',
      tiers: [
        { tierIndex: 0, label: 'Base' },
        { tierIndex: 1, label: 'Old' },
      ],
    });
    const rows = await replaceTiers(db, h.id, [
      { tierIndex: 0, label: 'Base', thresholdValue: 1 },
      { tierIndex: 1, label: 'New', thresholdValue: 2 },
      { tierIndex: 2, label: 'Elite', thresholdValue: 3 },
    ]);
    expect(rows.map((t) => [t.tierIndex, t.label])).toEqual([
      [0, 'Base'],
      [1, 'New'],
      [2, 'Elite'],
    ]);
    expect((await listTiers(db, h.id)).map((t) => t.label)).toEqual(['Base', 'New', 'Elite']);
  });

  it('refuses a ladder without tier 0 and leaves the old one in place', async () => {
    const h = await createHabit(db, {
      ownerId: owner(),
      name: 'Laps',
      type: 'tiered',
      tiers: [{ tierIndex: 0, label: 'Base' }],
    });
    await expect(replaceTiers(db, h.id, [{ tierIndex: 1, label: 'x' }])).rejects.toMatchObject({
      reason: 'missing_base_tier',
    });
    expect((await listTiers(db, h.id)).map((t) => t.label)).toEqual(['Base']);
  });

  it('refuses any ladder on a binary habit', async () => {
    const h = await createHabit(db, { ownerId: owner(), name: 'x', type: 'binary' });
    await expect(replaceTiers(db, h.id, [{ tierIndex: 0, label: 'Base' }])).rejects.toMatchObject({
      reason: 'not_tiered',
    });
  });
});

describe('findHabitTower', () => {
  it('returns the live membership and its tower for a bound habit', async () => {
    const s = await scenarios.towerRunningFor(2, { members: 1 });
    const m = s.members[0]!;
    const found = await findHabitTower(db, m.habit.id);
    expect(found?.tower.id).toBe(s.tower!.id);
    expect(found?.membership.id).toBe(m.membership.id);
  });

  it('returns undefined for a standalone habit and for a removed membership', async () => {
    const h = await createHabit(db, { ownerId: owner(), name: 'x', type: 'binary' });
    expect(await findHabitTower(db, h.id)).toBeUndefined();

    const tower = await createTower(db, {
      hostId: owner(),
      name: 'lobby',
      deadlineTime: '22:00',
      timezone: 'UTC',
    });
    const membership = await createMembership(db, {
      towerId: tower.id,
      userId: owner(),
      habitId: h.id,
    });
    expect((await findHabitTower(db, h.id))?.membership.id).toBe(membership.id);
    const { memberships } = await import('../towers/memberships/schema.js');
    await db.update(memberships).set({ state: 'removed' }).where(eq(memberships.id, membership.id));
    expect(await findHabitTower(db, h.id)).toBeUndefined();
    await db.delete(towers).where(eq(towers.id, tower.id));
  });
});
