import { db, memberships, towerPeriods, towers } from '@tower-of-habit/db';
import { periodPreviewResponseSchema, type PeriodPreviewResponse } from '@tower-of-habit/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { readErrorBody } from '../testing/harness.js';
import { useIntegrationApp } from '../testing/integration.js';

/*
 * 2.17: GET /towers/:id/period, read-only. Harness clock 2026-11-16T19:00Z
 * (noon Edmonton); deadline 22:00 MST = 05:00Z; wobble 03:00Z; evaluate 07:00Z.
 */

const it_ = useIntegrationApp();

async function started() {
  const s = await it_.fixtures.lobby({ members: 2 });
  expect(
    (await it_.request(`/v1/towers/${s.tower.id}/start`, { method: 'POST', as: s.host })).status
  ).toBe(200);
  return s;
}

async function preview(
  towerId: string,
  as: { token: string },
  now?: string
): Promise<PeriodPreviewResponse> {
  const res = await it_.request(`/v1/towers/${towerId}/period`, { as, ...(now ? { now } : {}) });
  expect(res.status, await res.clone().text()).toBe(200);
  return periodPreviewResponseSchema.parse(await res.json());
}

describe('GET /v1/towers/:id/period', () => {
  it('is open before wobbleAt with nobody logged, naming each member against quota', async () => {
    const s = await started();
    const body = await preview(s.tower.id, s.host);
    expect(body.periodStatus).toBe('open');
    expect(body.quota).toBe(1);
    expect(body.window).toMatchObject({
      periodStart: '2026-11-16',
      deadlineAt: '2026-11-17T05:00:00.000Z',
      evaluateAt: '2026-11-17T07:00:00.000Z',
    });
    expect(body.members.map((m) => [m.userId, m.qualifyingDays, m.standing])).toEqual([
      [s.host.user.id, 0, 'short'],
      [s.members[1]!.user.id, 0, 'short'],
    ]);
    expect(body.outstanding).toEqual([]);
    expect(body).toMatchObject({ height: 0, currentStreak: 0 });
  });

  it('is survived as soon as everyone has met quota, whatever the time', async () => {
    const s = await started();
    for (const m of s.members)
      await it_.request('/v1/entries', { as: m, json: { habitId: m.habit.id } });
    const body = await preview(s.tower.id, s.host);
    expect(body.periodStatus).toBe('survived');
    expect(body.members.every((m) => m.standing === 'met')).toBe(true);
  });

  it('is wobbling after wobbleAt, naming the outstanding member', async () => {
    const s = await started();
    await it_.request('/v1/entries', { as: s.host, json: { habitId: s.host.habit.id } });
    const body = await preview(s.tower.id, s.host, '2026-11-17T03:30:00.000Z');
    expect(body.periodStatus).toBe('wobbling');
    expect(body.outstanding).toEqual([s.members[1]!.membership.id]);
  });

  it('reports collapsed after evaluateAt but writes nothing', async () => {
    const s = await started();
    await it_.request('/v1/entries', { as: s.host, json: { habitId: s.host.habit.id } });
    const body = await preview(s.tower.id, s.host, '2026-11-17T07:00:00.000Z');
    expect(body.periodStatus).toBe('collapsed');
    const [period] = await db
      .select()
      .from(towerPeriods)
      .where(eq(towerPeriods.towerId, s.tower.id));
    expect(period!.state).toBe('pending');
    const [tower] = await db.select().from(towers).where(eq(towers.id, s.tower.id));
    expect(tower!.height).toBe(0);
    const rows = await db.select().from(memberships).where(eq(memberships.towerId, s.tower.id));
    expect(rows.every((m) => m.state === 'active' && m.consecutiveMissedPeriods === 0)).toBe(true);
  });

  it('excludes dormant members from the quota check', async () => {
    const s = await started();
    await db
      .update(memberships)
      .set({ state: 'dormant', dormantSince: it_.clock.now, dormancyReason: 'consecutive_miss' })
      .where(eq(memberships.id, s.members[1]!.membership.id));
    await it_.request('/v1/entries', { as: s.host, json: { habitId: s.host.habit.id } });
    const body = await preview(s.tower.id, s.host, '2026-11-17T03:30:00.000Z');
    expect(body.periodStatus).toBe('survived');
    expect(body.members.find((m) => m.membershipId === s.members[1]!.membership.id)?.standing).toBe(
      'excluded'
    );
  });

  it('reports soloActive true when only one member is active', async () => {
    const s = await started();
    await db
      .update(memberships)
      .set({ state: 'dormant', dormantSince: it_.clock.now, dormancyReason: 'consecutive_miss' })
      .where(eq(memberships.id, s.members[1]!.membership.id));
    const body = await preview(s.tower.id, s.host);
    expect(body.soloActive).toBe(true);
  });

  it('reports soloActive false when multiple members are active', async () => {
    const s = await started();
    const body = await preview(s.tower.id, s.host);
    expect(body.soloActive).toBe(false);
  });

  it('is 409 tower_not_started for a lobby, and 404 to non-members', async () => {
    const lobby = await it_.fixtures.lobby({ members: 2 });
    const res = await it_.request(`/v1/towers/${lobby.tower.id}/period`, { as: lobby.host });
    expect(res.status).toBe(409);
    expect((await readErrorBody(res)).error.code).toBe('tower_not_started');
    const stranger = await it_.fixtures.user();
    expect(
      (await it_.request(`/v1/towers/${lobby.tower.id}/period`, { as: stranger })).status
    ).toBe(404);
  });
});
