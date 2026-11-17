import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { useScenarios } from '../testing/vitest.js';
import { db, useTestOwner } from '../test-utils.js';
import { createHabit } from '../habits/habits.js';
import { createMembership } from '../towers/memberships/memberships.js';
import { memberships } from '../towers/memberships/schema.js';
import { towers } from '../towers/schema.js';
import { createTower, InvalidTimeZoneError } from '../towers/towers.js';
import { users } from './schema.js';
import { countActiveTowersForUser, getUser, updateUser, UserNotFoundError } from './users.js';

/*
 * 2.11: the profile reads and writes behind GET /me and PATCH /me.
 */

const owner = useTestOwner();
const scenarios = useScenarios();

describe('getUser', () => {
  it('returns the row, or undefined', async () => {
    expect((await getUser(db, owner()))?.id).toBe(owner());
    expect(await getUser(db, crypto.randomUUID())).toBeUndefined();
  });
});

describe('updateUser', () => {
  it('updates display name and timezone and bumps updated_at', async () => {
    const before = (await getUser(db, owner()))!;
    const row = await updateUser(db, owner(), { displayName: 'Max', timezone: 'Asia/Kolkata' });
    expect(row).toMatchObject({ displayName: 'Max', timezone: 'Asia/Kolkata' });
    expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
  });

  it('clears the display name with null', async () => {
    await updateUser(db, owner(), { displayName: 'Max' });
    expect((await updateUser(db, owner(), { displayName: null })).displayName).toBeNull();
  });

  it('rejects an invalid IANA zone before touching the row', async () => {
    await expect(updateUser(db, owner(), { timezone: 'PST' })).rejects.toBeInstanceOf(
      InvalidTimeZoneError
    );
    expect((await getUser(db, owner()))!.timezone).toBe('UTC');
  });

  it('never changes the email, even if one rides along', async () => {
    const before = (await getUser(db, owner()))!;
    const row = await updateUser(db, owner(), { email: 'x@y.z', displayName: 'Max' } as never);
    expect(row.email).toBe(before.email);
  });

  it('throws UserNotFoundError for an unknown id', async () => {
    await expect(updateUser(db, crypto.randomUUID(), { displayName: 'x' })).rejects.toBeInstanceOf(
      UserNotFoundError
    );
  });

  it('is a no-op with an empty patch', async () => {
    const before = (await getUser(db, owner()))!;
    expect(await updateUser(db, owner(), {})).toEqual(before);
  });
});

describe('countActiveTowersForUser', () => {
  it('counts towers the user is a live member of whose lifecycle is active', async () => {
    const s = await scenarios.towerRunningFor(3, { members: 2 });
    const [a, b] = s.members;
    expect(await countActiveTowersForUser(db, a!.user.id)).toBe(1);
    expect(await countActiveTowersForUser(db, b!.user.id)).toBe(1);
  });

  it('ignores draft (lobby) towers and removed memberships', async () => {
    const habit = await createHabit(db, { ownerId: owner(), name: 'x', type: 'binary' });
    const draft = await createTower(db, {
      hostId: owner(),
      name: 'lobby',
      deadlineTime: '22:00',
      timezone: 'UTC',
    });
    await createMembership(db, { towerId: draft.id, userId: owner(), habitId: habit.id });
    expect(await countActiveTowersForUser(db, owner())).toBe(0);

    const s = await scenarios.towerRunningFor(2, { members: 1 });
    const member = s.members[0]!;
    expect(await countActiveTowersForUser(db, member.user.id)).toBe(1);
    await db
      .update(memberships)
      .set({ state: 'removed' })
      .where(eq(memberships.id, member.membership.id));
    expect(await countActiveTowersForUser(db, member.user.id)).toBe(0);
    // towers restrict on host delete, so the draft tower goes explicitly.
    await db.delete(towers).where(eq(towers.id, draft.id));
  });

  it('is zero for a user with no memberships', async () => {
    const [u] = await db
      .insert(users)
      .values({ email: `${crypto.randomUUID()}@test.local` })
      .returning();
    expect(await countActiveTowersForUser(db, u!.id)).toBe(0);
    await db.delete(users).where(eq(users.id, u!.id));
  });
});
