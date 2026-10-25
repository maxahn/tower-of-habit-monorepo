import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  createHabit,
  deleteHabit,
  HabitNotFoundError,
  IllegalTransitionError,
  transitionHabit,
  updateHabit,
} from './habits.js';
import { users } from '../users/schema.js';
import { habits, type HabitLifecycle } from './schema.js';
import { db, pgError, useTestOwner } from '../test-utils.js';

const LIFECYCLES: HabitLifecycle[] = ['draft', 'active', 'paused', 'archived'];

const owner = useTestOwner();

describe('habits CRUD', () => {
  it('inserts with spec defaults', async () => {
    const h = await createHabit(db, { ownerId: owner(), name: 'Read', type: 'binary' });
    expect(h).toMatchObject({
      periodUnit: 'day',
      periodLength: 1,
      quota: 1,
      lifecycle: 'draft',
      unit: null,
      startedAt: null,
      archivedAt: null,
    });
    expect(h.createdAt).toBeInstanceOf(Date);
  });

  it('updates fields and bumps updatedAt', async () => {
    const h = await createHabit(db, { ownerId: owner(), name: 'Run', type: 'numeric', unit: 'km' });
    // $onUpdate stamps with the Node clock, while the insert default is the
    // DB's now(); compare like with like.
    const before = Date.now();
    const u = await updateHabit(db, h.id, { name: 'Jog', unit: 'miles' });
    expect(u).toMatchObject({ name: 'Jog', unit: 'miles' });
    expect(u.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('update ignores lifecycle even if smuggled in untyped', async () => {
    const h = await createHabit(db, { ownerId: owner(), name: 'Read', type: 'binary' });
    const u = await updateHabit(db, h.id, { lifecycle: 'archived', name: 'X' } as never);
    expect(u.lifecycle).toBe('draft');
    expect(u.name).toBe('X');
  });

  it('update of a missing habit throws', async () => {
    await expect(updateHabit(db, crypto.randomUUID(), { name: 'x' })).rejects.toBeInstanceOf(
      HabitNotFoundError
    );
  });

  it('deletes', async () => {
    const h = await createHabit(db, { ownerId: owner(), name: 'Read', type: 'binary' });
    await deleteHabit(db, h.id);
    expect(await db.select().from(habits).where(eq(habits.id, h.id))).toHaveLength(0);
  });
});

describe('habits constraints', () => {
  it('requires unit for numeric habits', async () => {
    const e = await pgError(createHabit(db, { ownerId: owner(), name: 'Run', type: 'numeric' }));
    expect(e).toMatchObject({ code: '23514', constraint_name: 'habits_unit_iff_numeric' });
  });

  it.each([
    { type: 'binary' as const },
    { type: 'tiered' as const, tiers: [{ tierIndex: 0, label: 'Base' }] },
  ])('forbids unit on $type habits', async (kind) => {
    const e = await pgError(
      createHabit(db, { ownerId: owner(), name: 'x', unit: 'minutes', ...kind })
    );
    expect(e).toMatchObject({ code: '23514', constraint_name: 'habits_unit_iff_numeric' });
  });

  it('forbids clearing unit on a numeric habit via update', async () => {
    const h = await createHabit(db, { ownerId: owner(), name: 'Run', type: 'numeric', unit: 'km' });
    const e = await pgError(updateHabit(db, h.id, { unit: null }));
    expect(e).toMatchObject({ constraint_name: 'habits_unit_iff_numeric' });
  });

  it.each([0, -1])('rejects quota %i', async (quota) => {
    const e = await pgError(
      createHabit(db, { ownerId: owner(), name: 'x', type: 'binary', quota })
    );
    expect(e).toMatchObject({ code: '23514', constraint_name: 'habits_quota_positive' });
  });

  it.each([0, -1])('rejects periodLength %i', async (periodLength) => {
    const e = await pgError(
      createHabit(db, { ownerId: owner(), name: 'x', type: 'binary', periodLength })
    );
    expect(e).toMatchObject({ code: '23514', constraint_name: 'habits_period_length_positive' });
  });

  it('rejects a nonexistent owner', async () => {
    const e = await pgError(
      createHabit(db, { ownerId: crypto.randomUUID(), name: 'x', type: 'binary' })
    );
    expect(e).toMatchObject({ code: '23503' });
  });

  it('cascades on user delete', async () => {
    const h = await createHabit(db, { ownerId: owner(), name: 'x', type: 'binary' });
    await db.delete(users).where(eq(users.id, owner()));
    expect(await db.select().from(habits).where(eq(habits.id, h.id))).toHaveLength(0);
  });

  // TODO: week-quota rule once decided.
});

describe('habit lifecycle transitions', () => {
  async function habitIn(state: HabitLifecycle) {
    const h = await createHabit(db, { ownerId: owner(), name: 'x', type: 'binary' });
    if (state === 'draft') return h;
    if (state === 'active') return transitionHabit(db, h.id, 'active');
    if (state === 'paused') {
      await transitionHabit(db, h.id, 'active');
      return transitionHabit(db, h.id, 'paused');
    }
    return transitionHabit(db, h.id, 'archived');
  }

  const cases = LIFECYCLES.flatMap((from) =>
    LIFECYCLES.map((to) => ({ from, to, legal: ALLOWED_TRANSITIONS[from].includes(to) }))
  );

  it.each(cases.filter((c) => c.legal))('allows $from -> $to', async ({ from, to }) => {
    const h = await habitIn(from);
    expect((await transitionHabit(db, h.id, to)).lifecycle).toBe(to);
  });

  it.each(cases.filter((c) => !c.legal))('rejects $from -> $to', async ({ from, to }) => {
    const h = await habitIn(from);
    await expect(transitionHabit(db, h.id, to)).rejects.toBeInstanceOf(IllegalTransitionError);
    const [row] = await db.select().from(habits).where(eq(habits.id, h.id));
    expect(row!.lifecycle).toBe(from);
  });

  it('sets startedAt on first activation only', async () => {
    const h = await habitIn('active');
    expect(h.startedAt).toBeInstanceOf(Date);
    await transitionHabit(db, h.id, 'paused');
    const resumed = await transitionHabit(db, h.id, 'active');
    expect(resumed.startedAt).toEqual(h.startedAt);
  });

  it('sets archivedAt on archive', async () => {
    const h = await habitIn('active');
    expect(h.archivedAt).toBeNull();
    expect((await transitionHabit(db, h.id, 'archived')).archivedAt).toBeInstanceOf(Date);
  });

  it('throws on a missing habit', async () => {
    await expect(transitionHabit(db, crypto.randomUUID(), 'active')).rejects.toBeInstanceOf(
      HabitNotFoundError
    );
  });

  it('a concurrent transition loses cleanly', async () => {
    const h = await habitIn('active');
    const results = await Promise.allSettled([
      transitionHabit(db, h.id, 'paused'),
      transitionHabit(db, h.id, 'archived'),
    ]);
    // Both are legal from active, so either order is valid; the end state
    // must be consistent with exactly one winner or archived-after-paused.
    const [row] = await db.select().from(habits).where(eq(habits.id, h.id));
    expect(['paused', 'archived']).toContain(row!.lifecycle);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
  });
});
