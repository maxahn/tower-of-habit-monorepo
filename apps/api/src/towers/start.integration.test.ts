import { db, habits, towerPeriods } from '@tower-of-habit/db';
import { towerDetailResponseSchema, type TowerActiveResponse } from '@tower-of-habit/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { readErrorBody } from '../testing/harness.js';
import { useIntegrationApp } from '../testing/integration.js';

/*
 * 2.15: POST /towers/:id/start. Creator only, >= 2 members, lobby -> active,
 * period 1 materialised in the same transaction.
 */

const it_ = useIntegrationApp();

async function start(s: { tower: { id: string } }, as: { token: string }, now?: string) {
  return it_.request(`/v1/towers/${s.tower.id}/start`, {
    method: 'POST',
    as,
    ...(now ? { now } : {}),
  });
}

async function active(res: Response): Promise<TowerActiveResponse> {
  expect(res.status, await res.clone().text()).toBe(200);
  const body = towerDetailResponseSchema.parse(await res.json());
  expect(body.kind).toBe('active');
  return body as TowerActiveResponse;
}

describe('POST /v1/towers/:id/start', () => {
  it('activates the tower and materialises period 1 on the tower-local date', async () => {
    const s = await it_.fixtures.lobby({ members: 2 }); // Edmonton, 22:00 deadline
    // Harness clock: 2026-11-16T19:00Z = noon Edmonton.
    const body = await active(await start(s, s.host));
    expect(body.tower).toMatchObject({
      lifecycle: 'active',
      startedAt: it_.clock.now.toISOString(),
      height: 0,
    });
    expect(body.currentPeriod).toMatchObject({
      periodStart: '2026-11-16',
      periodEnd: '2026-11-16',
      deadlineAt: '2026-11-17T05:00:00.000Z', // 22:00 MST
      evaluateAt: '2026-11-17T07:00:00.000Z', // + 120 grace
      state: 'pending',
    });
    const rows = await db.select().from(towerPeriods).where(eq(towerPeriods.towerId, s.tower.id));
    expect(rows).toHaveLength(1);
  });

  it('starts period 1 the next day when the start instant is past today’s deadline', async () => {
    const s = await it_.fixtures.lobby({ members: 2 });
    // 23:00 Edmonton on the 16th.
    const body = await active(await start(s, s.host, '2026-11-17T06:00:00.000Z'));
    expect(body.currentPeriod?.periodStart).toBe('2026-11-17');
  });

  it('is creator only (403) and member only (404)', async () => {
    const s = await it_.fixtures.lobby({ members: 2 });
    const asMember = await start(s, s.members[1]!);
    expect(asMember.status).toBe(403);
    expect((await readErrorBody(asMember)).error.code).toBe('forbidden');
    const stranger = await it_.fixtures.user();
    expect((await start(s, stranger)).status).toBe(404);
  });

  it('requires at least two memberships (409 tower_too_small)', async () => {
    const s = await it_.fixtures.lobby({ members: 1 });
    const res = await start(s, s.host);
    expect(res.status).toBe(409);
    expect((await readErrorBody(res)).error.code).toBe('tower_too_small');
  });

  it('requires every member habit to match the tower cadence (409 habit_cadence_mismatch)', async () => {
    const s = await it_.fixtures.lobby({ members: 2 });
    await db
      .update(habits)
      .set({ periodUnit: 'week' })
      .where(eq(habits.id, s.members[1]!.habit.id));
    const res = await start(s, s.host);
    expect(res.status).toBe(409);
    expect((await readErrorBody(res)).error.code).toBe('habit_cadence_mismatch');
    const rows = await db.select().from(towerPeriods).where(eq(towerPeriods.towerId, s.tower.id));
    expect(rows).toEqual([]); // one transaction: nothing half-written
  });

  it('is idempotent: a second call returns the existing state without a duplicate period', async () => {
    const s = await it_.fixtures.lobby({ members: 2 });
    const first = await active(await start(s, s.host));
    const second = await active(await start(s, s.host, '2026-11-18T19:00:00.000Z'));
    expect(second.tower.startedAt).toBe(first.tower.startedAt);
    expect(second.currentPeriod?.id).toBe(first.currentPeriod?.id);
    const rows = await db.select().from(towerPeriods).where(eq(towerPeriods.towerId, s.tower.id));
    expect(rows).toHaveLength(1);
  });
});
