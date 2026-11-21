import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createHabit } from '../habits/habits.js';
import { db, useTestOwner } from '../test-utils.js';
import { useScenarios } from '../testing/vitest.js';
import { createMembership } from './memberships/memberships.js';
import { towers } from './schema.js';
import {
  createTower,
  createTowerWithFreshCode,
  JoinCodeExhaustedError,
  listTowerMembers,
  listTowersForUser,
} from './towers.js';

/*
 * 2.13: the reads and writes behind tower creation and the lobby.
 */

const owner = useTestOwner();
const scenarios = useScenarios();

const created: string[] = [];
afterEach(async () => {
  for (const id of created.splice(0)) await db.delete(towers).where(eq(towers.id, id));
});

const INPUT = { name: 'Lobby', deadlineTime: '22:00', timezone: 'UTC' } as const;

describe('createTowerWithFreshCode', () => {
  it('retries a colliding join code and succeeds within the attempt budget', async () => {
    const existing = await createTower(db, { hostId: owner(), ...INPUT });
    created.push(existing.id);
    const codes = [existing.joinCode, existing.joinCode, existing.joinCode, existing.joinCode];
    const fresh = 'ZZZZ9999';
    const generate = () => codes.shift() ?? fresh;

    const tower = await createTowerWithFreshCode(db, { hostId: owner(), ...INPUT }, { generate });
    created.push(tower.id);
    expect(tower.joinCode).toBe(fresh);
  });

  it('gives up after 5 attempts with JoinCodeExhaustedError', async () => {
    const existing = await createTower(db, { hostId: owner(), ...INPUT });
    created.push(existing.id);
    let calls = 0;
    const generate = () => {
      calls += 1;
      return existing.joinCode;
    };
    await expect(
      createTowerWithFreshCode(db, { hostId: owner(), ...INPUT }, { generate })
    ).rejects.toBeInstanceOf(JoinCodeExhaustedError);
    expect(calls).toBe(5);
  });

  it('stores the code upper-cased so lookups are case-insensitive', async () => {
    const tower = await createTowerWithFreshCode(
      db,
      { hostId: owner(), ...INPUT },
      { generate: () => 'abcd2345' }
    );
    created.push(tower.id);
    expect(tower.joinCode).toBe('ABCD2345');
  });
});

describe('listTowersForUser', () => {
  it('returns towers the user holds a live membership in, with their state', async () => {
    const s = await scenarios.towerRunningFor(2, { members: 2 });
    const [a, b] = s.members;
    const habit = await createHabit(db, { ownerId: a!.user.id, name: 'x', type: 'binary' });
    const lobby = await createTower(db, { hostId: a!.user.id, ...INPUT });
    created.push(lobby.id);
    await createMembership(db, { towerId: lobby.id, userId: a!.user.id, habitId: habit.id });

    const forA = await listTowersForUser(db, a!.user.id);
    expect(forA.map((t) => t.tower.id).sort()).toEqual([s.tower!.id, lobby.id].sort());
    expect(forA.every((t) => t.membershipState === 'active')).toBe(true);
    expect(forA.find((t) => t.tower.id === s.tower!.id)?.memberCount).toBe(2);
    expect((await listTowersForUser(db, b!.user.id)).map((t) => t.tower.id)).toEqual([s.tower!.id]);
  });
});

describe('listTowerMembers', () => {
  it('joins memberships to the user and habit, host first then by join time', async () => {
    const s = await scenarios.towerRunningFor(2, { members: 3 });
    const members = await listTowerMembers(db, s.tower!.id);
    expect(members).toHaveLength(3);
    expect(members[0]!.userId).toBe(s.tower!.hostId);
    for (const m of members) {
      const expected = s.members.find((x) => x.membership.id === m.membershipId)!;
      expect(m).toMatchObject({
        userId: expected.user.id,
        displayName: expected.user.displayName,
        habitId: expected.habit.id,
        habitName: expected.habit.name,
        habitType: expected.habit.type,
        state: expected.membership.state,
      });
    }
  });
});
