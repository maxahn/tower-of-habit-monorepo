import { db, memberships, towers } from '@tower-of-habit/db';
import {
  towerDetailResponseSchema,
  towerListResponseSchema,
  type TowerDetailResponse,
} from '@tower-of-habit/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { readErrorBody } from '../testing/harness.js';
import { useIntegrationApp } from '../testing/integration.js';

/*
 * 2.13: tower creation and the lobby, over HTTP.
 */

const it_ = useIntegrationApp();

const BODY = { name: 'Morning crew', deadlineTime: '22:00', timezone: 'America/Edmonton' };

async function detail(res: Response): Promise<TowerDetailResponse> {
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return towerDetailResponseSchema.parse(await res.json());
}

describe('POST /v1/towers', () => {
  it('creates a lobby tower with the creator’s membership and chosen habit', async () => {
    const me = await it_.fixtures.user({ displayName: 'Max' });
    const habit = await it_.fixtures.habit(me, { name: 'Run' });
    const res = await it_.request('/v1/towers', { as: me, json: { ...BODY, habitId: habit.id } });
    expect(res.status).toBe(201);
    const body = await detail(res);
    expect(body.kind).toBe('lobby');
    if (body.kind !== 'lobby') return;
    expect(body.tower).toMatchObject({
      name: 'Morning crew',
      lifecycle: 'draft',
      hostId: me.user.id,
      graceWindowMinutes: 120,
      wobbleLeadMinutes: 120,
      height: 0,
    });
    expect(body.role).toBe('host');
    expect(body.joinCode).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
    expect(body.members).toEqual([
      expect.objectContaining({
        userId: me.user.id,
        displayName: 'Max',
        habitId: habit.id,
        habitName: 'Run',
        state: 'active',
      }),
    ]);
  });

  it('validates deadline, timezone, grace and wobble at creation', async () => {
    const me = await it_.fixtures.user();
    const habit = await it_.fixtures.habit(me);
    for (const bad of [
      { deadlineTime: '25:00' },
      { timezone: 'PST' },
      { graceWindowMinutes: 361 },
      { graceWindowMinutes: -1 },
      { wobbleLeadMinutes: 1440 },
    ]) {
      const res = await it_.request('/v1/towers', {
        as: me,
        json: { ...BODY, habitId: habit.id, ...bad },
      });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect((await readErrorBody(res)).error.code).toBe('validation_failed');
    }
  });

  it('rejects a habit the caller does not own with 404', async () => {
    const me = await it_.fixtures.user();
    const other = await it_.fixtures.user();
    const theirs = await it_.fixtures.habit(other);
    const res = await it_.request('/v1/towers', { as: me, json: { ...BODY, habitId: theirs.id } });
    expect(res.status).toBe(404);
  });

  it('rejects a habit already bound to a non-collapsed tower (409 habit_already_committed)', async () => {
    const me = await it_.fixtures.user();
    const habit = await it_.fixtures.habit(me);
    expect(
      (await it_.request('/v1/towers', { as: me, json: { ...BODY, habitId: habit.id } })).status
    ).toBe(201);
    const res = await it_.request('/v1/towers', { as: me, json: { ...BODY, habitId: habit.id } });
    expect(res.status).toBe(409);
    expect((await readErrorBody(res)).error.code).toBe('habit_already_committed');
  });

  it('rejects a habit whose cadence differs from the tower’s (409 habit_cadence_mismatch)', async () => {
    const me = await it_.fixtures.user();
    const habit = await it_.fixtures.habit(me);
    await db
      .update((await import('@tower-of-habit/db')).habits)
      .set({ periodUnit: 'week', periodLength: 1 })
      .where(eq((await import('@tower-of-habit/db')).habits.id, habit.id));
    const res = await it_.request('/v1/towers', { as: me, json: { ...BODY, habitId: habit.id } });
    expect(res.status).toBe(409);
    expect((await readErrorBody(res)).error.code).toBe('habit_cadence_mismatch');
  });

  it('rejects an archived habit', async () => {
    const me = await it_.fixtures.user();
    const habit = await it_.fixtures.habit(me);
    await it_.request(`/v1/habits/${habit.id}/archive`, { method: 'POST', as: me });
    const res = await it_.request('/v1/towers', { as: me, json: { ...BODY, habitId: habit.id } });
    expect(res.status).toBe(409);
    expect((await readErrorBody(res)).error.code).toBe('habit_archived');
  });
});

describe('GET /v1/towers', () => {
  it('lists the caller’s towers with their membership state and member count', async () => {
    const s = await it_.fixtures.lobby({ members: 2 });
    const stranger = await it_.fixtures.user();
    const res = await it_.request('/v1/towers', { as: s.host });
    const body = towerListResponseSchema.parse(await res.json());
    expect(body.towers).toHaveLength(1);
    expect(body.towers[0]).toMatchObject({ membershipState: 'active', memberCount: 2 });
    expect(body.towers[0]!.tower.id).toBe(s.tower.id);
    const none = towerListResponseSchema.parse(
      await (await it_.request('/v1/towers', { as: stranger })).json()
    );
    expect(none.towers).toEqual([]);
  });
});

describe('GET /v1/towers/:id', () => {
  it('returns the lobby shape to members, with role', async () => {
    const s = await it_.fixtures.lobby({ members: 2 });
    const asHost = await detail(await it_.request(`/v1/towers/${s.tower.id}`, { as: s.host }));
    expect(asHost.kind).toBe('lobby');
    expect(asHost.role).toBe('host');
    const asMember = await detail(
      await it_.request(`/v1/towers/${s.tower.id}`, { as: s.members[1]! })
    );
    expect(asMember.role).toBe('member');
    expect(asMember.members.map((m) => m.userId)).toEqual(s.members.map((m) => m.user.id));
  });

  it('returns 404, not 403, to a non-member and for an unknown id', async () => {
    const s = await it_.fixtures.lobby({ members: 1 });
    const stranger = await it_.fixtures.user();
    const res = await it_.request(`/v1/towers/${s.tower.id}`, { as: stranger });
    expect(res.status).toBe(404);
    expect((await readErrorBody(res)).error.code).toBe('not_found');
    expect((await it_.request(`/v1/towers/${crypto.randomUUID()}`, { as: stranger })).status).toBe(
      404
    );
  });

  it('returns the active shape once the tower is active, without the join code', async () => {
    const s = await it_.fixtures.lobby({ members: 2 });
    await db
      .update(towers)
      .set({ lifecycle: 'active', startedAt: it_.clock.now, height: 2, currentStreak: 2 })
      .where(eq(towers.id, s.tower.id));
    const body = await detail(await it_.request(`/v1/towers/${s.tower.id}`, { as: s.host }));
    expect(body.kind).toBe('active');
    if (body.kind !== 'active') return;
    expect(body.tower.height).toBe(2);
    expect(body.currentPeriod).toBeNull();
    expect(body.blocks).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(s.tower.joinCode);
  });

  it('reports soloActive true when only one member is active', async () => {
    const s = await it_.fixtures.lobby({ members: 2 });
    await db
      .update(towers)
      .set({ lifecycle: 'active', startedAt: it_.clock.now })
      .where(eq(towers.id, s.tower.id));
    await db
      .update(memberships)
      .set({ state: 'dormant', dormantSince: it_.clock.now, dormancyReason: 'consecutive_miss' })
      .where(eq(memberships.id, s.members[1]!.membership.id));
    const body = await detail(await it_.request(`/v1/towers/${s.tower.id}`, { as: s.host }));
    expect(body.kind).toBe('active');
    if (body.kind !== 'active') return;
    expect(body.soloActive).toBe(true);
  });

  it('reports soloActive false when multiple members are active', async () => {
    const s = await it_.fixtures.lobby({ members: 2 });
    await db
      .update(towers)
      .set({ lifecycle: 'active', startedAt: it_.clock.now })
      .where(eq(towers.id, s.tower.id));
    const body = await detail(await it_.request(`/v1/towers/${s.tower.id}`, { as: s.host }));
    expect(body.kind).toBe('active');
    if (body.kind !== 'active') return;
    expect(body.soloActive).toBe(false);
  });

  it('is 404 to a removed member', async () => {
    const s = await it_.fixtures.lobby({ members: 2 });
    const leaver = s.members[1]!;
    await db
      .update(memberships)
      .set({ state: 'removed' })
      .where(eq(memberships.id, leaver.membership.id));
    expect((await it_.request(`/v1/towers/${s.tower.id}`, { as: leaver })).status).toBe(404);
  });
});
