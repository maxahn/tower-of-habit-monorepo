import { db, entries, towers } from '@tower-of-habit/db';
import {
  habitDetailResponseSchema,
  habitListResponseSchema,
  type HabitDetailResponse,
} from '@tower-of-habit/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { readErrorBody } from '../testing/harness.js';
import { useIntegrationApp } from '../testing/integration.js';

/*
 * 2.12: habits and tiers over HTTP. The load-bearing rule: a habit bound into
 * an ACTIVE tower may not change its cadence or its tier 0 threshold (that is
 * what the tower checks), while tiers above 0 stay editable.
 */

const it_ = useIntegrationApp();

const NUMERIC = {
  name: 'Read',
  type: 'numeric',
  unit: 'pages',
  tiers: [
    { tierIndex: 0, label: 'Base', thresholdValue: 10 },
    { tierIndex: 1, label: 'Deep', thresholdValue: 30 },
  ],
} as const;

async function detail(res: Response): Promise<HabitDetailResponse> {
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return habitDetailResponseSchema.parse(await res.json());
}

/** Binds the habit into a tower owned by `actor` and makes that tower active. */
async function bindToActiveTower(
  actor: Awaited<ReturnType<typeof it_.fixtures.user>>,
  habitId: string
) {
  const tower = await it_.fixtures.tower(actor);
  const { getHabit } = await import('@tower-of-habit/db');
  const habit = (await getHabit(db, habitId))!;
  await it_.fixtures.membership(tower, actor, habit);
  await db
    .update(towers)
    .set({ lifecycle: 'active', startedAt: it_.clock.now })
    .where(eq(towers.id, tower.id));
  return tower;
}

describe('POST /v1/habits', () => {
  it('creates a binary habit, active, owned by the caller', async () => {
    const me = await it_.fixtures.user();
    const res = await it_.request('/v1/habits', {
      as: me,
      json: { name: 'Meditate', type: 'binary' },
    });
    expect(res.status).toBe(201);
    const body = await detail(res);
    expect(body.habit).toMatchObject({
      name: 'Meditate',
      type: 'binary',
      ownerId: me.user.id,
      lifecycle: 'active',
    });
    expect(body.habit.startedAt).toBe(it_.clock.now.toISOString());
    expect(body.tiers).toEqual([]);
    expect(body.currentStreak).toBe(0);
    expect(body.tower).toBeNull();
  });

  it('creates a numeric habit with its ladder', async () => {
    const me = await it_.fixtures.user();
    const body = await detail(await it_.request('/v1/habits', { as: me, json: NUMERIC }));
    expect(body.tiers.map((t) => [t.tierIndex, t.thresholdValue])).toEqual([
      [0, 10],
      [1, 30],
    ]);
  });

  it('rejects a numeric ladder with non-increasing thresholds (400 validation_failed)', async () => {
    const me = await it_.fixtures.user();
    const res = await it_.request('/v1/habits', {
      as: me,
      json: {
        ...NUMERIC,
        tiers: [NUMERIC.tiers[0], { tierIndex: 1, label: 'x', thresholdValue: 10 }],
      },
    });
    expect(res.status).toBe(400);
    expect((await readErrorBody(res)).error.code).toBe('validation_failed');
  });
});

describe('GET /v1/habits and GET /v1/habits/:id', () => {
  it('lists only the caller’s habits', async () => {
    const me = await it_.fixtures.user();
    const other = await it_.fixtures.user();
    await it_.fixtures.habit(me, { name: 'Mine' });
    await it_.fixtures.habit(other, { name: 'Theirs' });
    const res = await it_.request('/v1/habits', { as: me });
    const body = habitListResponseSchema.parse(await res.json());
    expect(body.habits.map((h) => h.name)).toEqual(['Mine']);
  });

  it('returns 404 for another user’s habit', async () => {
    const me = await it_.fixtures.user();
    const other = await it_.fixtures.user();
    const theirs = await it_.fixtures.habit(other);
    const res = await it_.request(`/v1/habits/${theirs.id}`, { as: me });
    expect(res.status).toBe(404);
    expect((await readErrorBody(res)).error.code).toBe('not_found');
  });

  it('includes the current streak, the ladder and the owning tower', async () => {
    const me = await it_.fixtures.user({ timezone: 'America/Edmonton' });
    const habit = await it_.fixtures.habit(me, { type: 'tiered' });
    // Clock: 2026-11-16 noon Edmonton. Two days logged ending yesterday.
    await db.insert(entries).values([
      {
        habitId: habit.id,
        localDate: '2026-11-15',
        loggedAt: new Date('2026-11-16T01:00:00Z'),
        countsTowardQuota: true,
      },
      {
        habitId: habit.id,
        localDate: '2026-11-14',
        loggedAt: new Date('2026-11-15T01:00:00Z'),
        countsTowardQuota: true,
      },
      {
        habitId: habit.id,
        localDate: '2026-11-10',
        loggedAt: new Date('2026-11-11T01:00:00Z'),
        countsTowardQuota: true,
      },
    ]);
    const tower = await bindToActiveTower(me, habit.id);
    const body = await detail(await it_.request(`/v1/habits/${habit.id}`, { as: me }));
    expect(body.currentStreak).toBe(2);
    expect(body.tiers.map((t) => t.tierIndex)).toEqual([0, 1]);
    expect(body.tower).toMatchObject({
      id: tower.id,
      lifecycle: 'active',
      membershipState: 'active',
    });
  });
});

describe('PATCH /v1/habits/:id', () => {
  it('renames a habit', async () => {
    const me = await it_.fixtures.user();
    const habit = await it_.fixtures.habit(me);
    const body = await detail(
      await it_.request(`/v1/habits/${habit.id}`, {
        method: 'PATCH',
        as: me,
        json: { name: 'Jog' },
      })
    );
    expect(body.habit.name).toBe('Jog');
  });

  it('rejects a cadence change while bound into an active tower (409 habit_locked_by_tower)', async () => {
    const me = await it_.fixtures.user();
    const habit = await it_.fixtures.habit(me);
    await bindToActiveTower(me, habit.id);
    const res = await it_.request(`/v1/habits/${habit.id}`, {
      method: 'PATCH',
      as: me,
      json: { periodUnit: 'week' },
    });
    expect(res.status).toBe(409);
    expect((await readErrorBody(res)).error.code).toBe('habit_locked_by_tower');
    // A rename is still fine.
    const ok = await it_.request(`/v1/habits/${habit.id}`, {
      method: 'PATCH',
      as: me,
      json: { name: 'Still ok' },
    });
    expect(ok.status).toBe(200);
  });

  it('rejects type changes outright (400)', async () => {
    const me = await it_.fixtures.user();
    const habit = await it_.fixtures.habit(me);
    const res = await it_.request(`/v1/habits/${habit.id}`, {
      method: 'PATCH',
      as: me,
      json: { type: 'numeric' },
    });
    expect(res.status).toBe(400);
  });
});

describe('PUT /v1/habits/:id/tiers', () => {
  it('replaces the ladder wholesale', async () => {
    const me = await it_.fixtures.user();
    const habit = await it_.fixtures.habit(me, { type: 'tiered' });
    const body = await detail(
      await it_.request(`/v1/habits/${habit.id}/tiers`, {
        method: 'PUT',
        as: me,
        json: {
          tiers: [
            { tierIndex: 0, label: 'Base', thresholdValue: null },
            { tierIndex: 1, label: 'Big', thresholdValue: null },
            { tierIndex: 2, label: 'Huge', thresholdValue: null },
          ],
        },
      })
    );
    expect(body.tiers.map((t) => t.label)).toEqual(['Base', 'Big', 'Huge']);
  });

  it('rejects gaps in the ladder (400 validation_failed, field-keyed details)', async () => {
    const me = await it_.fixtures.user();
    const habit = await it_.fixtures.habit(me, { type: 'tiered' });
    const res = await it_.request(`/v1/habits/${habit.id}/tiers`, {
      method: 'PUT',
      as: me,
      json: {
        tiers: [
          { tierIndex: 0, label: 'Base', thresholdValue: null },
          { tierIndex: 2, label: 'Gap', thresholdValue: null },
        ],
      },
    });
    expect(res.status).toBe(400);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe('validation_failed');
    expect(Object.keys(body.error.details as object)[0]).toMatch(/^tiers/);
  });

  it('rejects a ladder on a binary habit', async () => {
    const me = await it_.fixtures.user();
    const habit = await it_.fixtures.habit(me);
    const res = await it_.request(`/v1/habits/${habit.id}/tiers`, {
      method: 'PUT',
      as: me,
      json: { tiers: [{ tierIndex: 0, label: 'Base', thresholdValue: null }] },
    });
    expect(res.status).toBe(400);
  });

  it('locks tier 0’s threshold while bound into an active tower, but not the tiers above it', async () => {
    const me = await it_.fixtures.user();
    const created = await detail(await it_.request('/v1/habits', { as: me, json: NUMERIC }));
    await bindToActiveTower(me, created.habit.id);
    const path = `/v1/habits/${created.habit.id}/tiers`;

    const floor = await it_.request(path, {
      method: 'PUT',
      as: me,
      json: {
        tiers: [
          { tierIndex: 0, label: 'Base', thresholdValue: 5 },
          { tierIndex: 1, label: 'Deep', thresholdValue: 30 },
        ],
      },
    });
    expect(floor.status).toBe(409);
    expect((await readErrorBody(floor)).error.code).toBe('habit_locked_by_tower');

    const ceiling = await detail(
      await it_.request(path, {
        method: 'PUT',
        as: me,
        json: {
          tiers: [
            { tierIndex: 0, label: 'Base renamed', thresholdValue: 10 },
            { tierIndex: 1, label: 'Deeper', thresholdValue: 50 },
          ],
        },
      })
    );
    expect(ceiling.tiers.map((t) => [t.label, t.thresholdValue])).toEqual([
      ['Base renamed', 10],
      ['Deeper', 50],
    ]);
  });
});

describe('POST /v1/habits/:id/archive', () => {
  it('archives a standalone habit (idempotently)', async () => {
    const me = await it_.fixtures.user();
    const habit = await it_.fixtures.habit(me);
    const body = await detail(
      await it_.request(`/v1/habits/${habit.id}/archive`, { method: 'POST', as: me })
    );
    expect(body.habit.lifecycle).toBe('archived');
    expect(body.habit.archivedAt).toBe(it_.clock.now.toISOString());
    const again = await it_.request(`/v1/habits/${habit.id}/archive`, { method: 'POST', as: me });
    expect(again.status).toBe(200);
  });

  it('refuses to archive a habit bound into an active tower', async () => {
    const me = await it_.fixtures.user();
    const habit = await it_.fixtures.habit(me);
    await bindToActiveTower(me, habit.id);
    const res = await it_.request(`/v1/habits/${habit.id}/archive`, { method: 'POST', as: me });
    expect(res.status).toBe(409);
    expect((await readErrorBody(res)).error.code).toBe('habit_locked_by_tower');
  });
});
