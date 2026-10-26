import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALLOWED_MEMBERSHIP_TRANSITIONS,
  assertMembershipTransition,
  createMembership,
  deleteMembership,
  getMembership,
  IllegalMembershipTransitionError,
  listMembershipsForTower,
  MembershipNotFoundError,
  transitionMembership,
  updateMembership,
  type MembershipTransition,
} from './memberships.js';
import { createHabit, deleteHabit } from '../../habits/habits.js';
import { users } from '../../users/schema.js';
import { createTower, deleteTower } from '../towers.js';
import { DEFAULT_DEADLINE_TIME, towers } from '../schema.js';
import { memberships, type MembershipState } from './schema.js';
import { db, pgError, useTestOwner } from '../../test-utils.js';

const STATES: MembershipState[] = ['active', 'at_risk', 'dormant', 'removed'];

const owner = useTestOwner();

// Deleting the owner's towers cascades to memberships, which would otherwise
// block deleting the owner and their habits (no on-delete action). Vitest runs
// afterEach hooks in reverse registration order: this one runs first.
afterEach(async () => {
  await db.delete(towers).where(eq(towers.hostId, owner()));
});

function tower() {
  return createTower(db, {
    hostId: owner(),
    name: 'Morning run',
    deadlineTime: DEFAULT_DEADLINE_TIME,
    timezone: 'America/Edmonton',
  });
}

function habit() {
  return createHabit(db, { ownerId: owner(), name: 'Run', type: 'binary' });
}

async function membership() {
  const [t, h] = await Promise.all([tower(), habit()]);
  return createMembership(db, { towerId: t.id, userId: owner(), habitId: h.id });
}

function to(state: MembershipState): MembershipTransition {
  return state === 'dormant' ? { to: 'dormant', reason: 'consecutive_miss' } : { to: state };
}

async function stateOf(id: string) {
  return (await getMembership(db, id))!.state;
}

describe('memberships CRUD', () => {
  it('inserts with spec defaults', async () => {
    const m = await membership();
    expect(m).toMatchObject({
      userId: owner(),
      state: 'active',
      consecutiveMissedPeriods: 0,
      lastQualifyingDate: null,
      dormantSince: null,
      dormancyReason: null,
      voluntaryReturnDate: null,
    });
    expect(m.joinedAt).toBeInstanceOf(Date);
  });

  it('gets and lists by tower', async () => {
    const m = await membership();
    expect(await getMembership(db, m.id)).toEqual(m);
    expect(await listMembershipsForTower(db, m.towerId)).toEqual([m]);
    expect(await getMembership(db, crypto.randomUUID())).toBeUndefined();
  });

  it('updates evaluator fields, round-tripping dates as strings', async () => {
    const m = await membership();
    const u = await updateMembership(db, m.id, {
      consecutiveMissedPeriods: 1,
      lastQualifyingDate: '2026-10-24',
      voluntaryReturnDate: '2026-11-01',
    });
    expect(u).toMatchObject({
      consecutiveMissedPeriods: 1,
      lastQualifyingDate: '2026-10-24',
      voluntaryReturnDate: '2026-11-01',
    });
  });

  it('update ignores state, dormancy and identity fields even if smuggled in untyped', async () => {
    const m = await membership();
    const other = await tower();
    const u = await updateMembership(db, m.id, {
      state: 'dormant',
      dormancyReason: 'voluntary',
      dormantSince: new Date(),
      towerId: other.id,
      consecutiveMissedPeriods: 2,
    } as never);
    expect(u).toMatchObject({
      state: 'active',
      dormancyReason: null,
      dormantSince: null,
      towerId: m.towerId,
      consecutiveMissedPeriods: 2,
    });
  });

  it('updating a missing membership throws; deleting one is a no-op', async () => {
    await expect(
      updateMembership(db, crypto.randomUUID(), { consecutiveMissedPeriods: 1 })
    ).rejects.toBeInstanceOf(MembershipNotFoundError);
    await expect(deleteMembership(db, crypto.randomUUID())).resolves.toBeUndefined();
  });

  it('deletes', async () => {
    const m = await membership();
    await deleteMembership(db, m.id);
    expect(await getMembership(db, m.id)).toBeUndefined();
  });
});

describe('memberships constraints', () => {
  it('rejects a second membership for the same (tower, user)', async () => {
    const m = await membership();
    const h2 = await habit();
    const e = await pgError(
      createMembership(db, { towerId: m.towerId, userId: owner(), habitId: h2.id })
    );
    expect(e).toMatchObject({
      code: '23505',
      constraint_name: 'memberships_tower_id_user_id_unique',
    });
  });

  it('one_active_tower_per_habit rejects a second live tower for one habit', async () => {
    const m = await membership();
    const t2 = await tower();
    const e = await pgError(
      createMembership(db, { towerId: t2.id, userId: owner(), habitId: m.habitId })
    );
    expect(e).toMatchObject({ code: '23505', constraint_name: 'one_active_tower_per_habit' });
  });

  it.each(['at_risk', 'dormant'] as const)(
    'one_active_tower_per_habit still counts a %s membership',
    async (state) => {
      const m = await membership();
      await transitionMembership(db, m.id, to(state));
      const t2 = await tower();
      const e = await pgError(
        createMembership(db, { towerId: t2.id, userId: owner(), habitId: m.habitId })
      );
      expect(e).toMatchObject({ constraint_name: 'one_active_tower_per_habit' });
    }
  );

  it('one_active_tower_per_habit frees the habit once the membership is removed', async () => {
    const m = await membership();
    await transitionMembership(db, m.id, { to: 'removed' });
    const t2 = await tower();
    const m2 = await createMembership(db, { towerId: t2.id, userId: owner(), habitId: m.habitId });
    expect(m2.state).toBe('active');
  });

  it('rejects a negative missed-period count', async () => {
    const m = await membership();
    const e = await pgError(updateMembership(db, m.id, { consecutiveMissedPeriods: -1 }));
    expect(e).toMatchObject({
      code: '23514',
      constraint_name: 'memberships_missed_periods_nonnegative',
    });
  });

  it.each([
    { state: 'dormant' as const },
    { state: 'dormant' as const, dormantSince: new Date() },
    { state: 'dormant' as const, dormancyReason: 'backstop' as const },
    { state: 'active' as const, dormantSince: new Date(), dormancyReason: 'backstop' as const },
  ])('requires dormancy fields iff dormant (%j)', async (values) => {
    const m = await membership();
    const e = await pgError(db.update(memberships).set(values).where(eq(memberships.id, m.id)));
    expect(e).toMatchObject({ code: '23514', constraint_name: 'memberships_dormancy_iff_dormant' });
  });

  it.each(['towerId', 'userId', 'habitId'] as const)('rejects a nonexistent %s', async (key) => {
    const [t, h] = await Promise.all([tower(), habit()]);
    const input = { towerId: t.id, userId: owner(), habitId: h.id, [key]: crypto.randomUUID() };
    expect(await pgError(createMembership(db, input))).toMatchObject({ code: '23503' });
  });

  it('cascades on tower delete', async () => {
    const m = await membership();
    await deleteTower(db, m.towerId);
    expect(await getMembership(db, m.id)).toBeUndefined();
  });

  it('blocks deleting a habit that has a membership', async () => {
    const m = await membership();
    const e = await pgError(deleteHabit(db, m.habitId));
    expect(e).toMatchObject({
      code: '23503',
      constraint_name: 'memberships_habit_id_habits_id_fk',
    });
  });

  it('blocks deleting a user who has a membership', async () => {
    const m = await membership();
    // Host is the same user; move the tower to another host so only the
    // membership FK is in play.
    const [other] = await db
      .insert(users)
      .values({
        email: `${crypto.randomUUID()}@test.local`,
        passwordHash: 'x',
        displayName: 'Host',
      })
      .returning();
    try {
      await db.update(towers).set({ hostId: other!.id }).where(eq(towers.id, m.towerId));
      const e = await pgError(db.delete(users).where(eq(users.id, owner())));
      expect(e).toMatchObject({ code: '23503' });
      expect(e.constraint_name).toMatch(/^memberships_/);
    } finally {
      await deleteTower(db, m.towerId);
      await db.delete(users).where(eq(users.id, other!.id));
    }
  });
});

describe('membership state transitions', () => {
  async function membershipIn(state: MembershipState) {
    const m = await membership();
    if (state === 'active') return m;
    return transitionMembership(db, m.id, to(state));
  }

  const cases = STATES.flatMap((from) =>
    STATES.map((t) => ({ from, to: t, legal: ALLOWED_MEMBERSHIP_TRANSITIONS[from].includes(t) }))
  );

  it.each(cases.filter((c) => c.legal))('allows $from -> $to', async ({ from, to: target }) => {
    const m = await membershipIn(from);
    expect((await transitionMembership(db, m.id, to(target))).state).toBe(target);
  });

  it.each(cases.filter((c) => !c.legal))('rejects $from -> $to', async ({ from, to: target }) => {
    const m = await membershipIn(from);
    expect(() => assertMembershipTransition(from, target)).toThrow(
      IllegalMembershipTransitionError
    );
    await expect(transitionMembership(db, m.id, to(target))).rejects.toBeInstanceOf(
      IllegalMembershipTransitionError
    );
    expect(await stateOf(m.id)).toBe(from);
  });

  it('going dormant stamps dormantSince and the reason', async () => {
    const m = await membership();
    const d = await transitionMembership(db, m.id, { to: 'dormant', reason: 'voluntary' });
    expect(d.dormantSince).toBeInstanceOf(Date);
    expect(d.dormancyReason).toBe('voluntary');
  });

  it('returning to active clears dormancy and resets the miss counter', async () => {
    const m = await membership();
    await updateMembership(db, m.id, { consecutiveMissedPeriods: 2 });
    await transitionMembership(db, m.id, { to: 'dormant', reason: 'consecutive_miss' });
    const back = await transitionMembership(db, m.id, { to: 'active' });
    expect(back).toMatchObject({
      state: 'active',
      dormantSince: null,
      dormancyReason: null,
      consecutiveMissedPeriods: 0,
    });
  });

  it('at_risk keeps the miss counter', async () => {
    const m = await membership();
    await updateMembership(db, m.id, { consecutiveMissedPeriods: 1 });
    expect((await transitionMembership(db, m.id, { to: 'at_risk' })).consecutiveMissedPeriods).toBe(
      1
    );
  });

  it('removing a dormant membership clears dormancy fields', async () => {
    const m = await membershipIn('dormant');
    const r = await transitionMembership(db, m.id, { to: 'removed' });
    expect(r).toMatchObject({ state: 'removed', dormantSince: null, dormancyReason: null });
  });

  it('throws on a missing membership', async () => {
    await expect(
      transitionMembership(db, crypto.randomUUID(), { to: 'at_risk' })
    ).rejects.toBeInstanceOf(MembershipNotFoundError);
  });

  it('a concurrent transition loses cleanly', async () => {
    const m = await membership();
    const results = await Promise.allSettled([
      transitionMembership(db, m.id, { to: 'at_risk' }),
      transitionMembership(db, m.id, { to: 'removed' }),
    ]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    // Either one winner, or at_risk then removed (legal from at_risk).
    expect(['at_risk', 'removed']).toContain(await stateOf(m.id));
  });

  it('requires a reason to go dormant at the type level', () => {
    // @ts-expect-error dormancy reason is required
    const t: MembershipTransition = { to: 'dormant' };
    void t;
  });
});
