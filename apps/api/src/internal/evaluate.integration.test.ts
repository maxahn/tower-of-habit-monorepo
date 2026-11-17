import { db, memberships, towerPeriods, towers, verifyTower } from '@tower-of-habit/db';
import { evaluationResponseSchema, type EvaluationResponse } from '@tower-of-habit/shared';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { readErrorBody } from '../testing/harness.js';
import { useIntegrationApp, type LobbyScenario } from '../testing/integration.js';

/*
 * 2.19: the manual stand-in for the Phase 3 tick. Clock: 2026-11-16T19:00Z
 * (noon Edmonton); each day's deadline 05:00Z next day, evaluateAt 07:00Z.
 */

const TOKEN = 'internal-test-token';
const it_ = useIntegrationApp({ internalApiToken: TOKEN });
const internal = { token: TOKEN };

async function started(members = 2) {
  const s = await it_.fixtures.lobby({ members });
  expect(
    (await it_.request(`/v1/towers/${s.tower.id}/start`, { method: 'POST', as: s.host })).status
  ).toBe(200);
  return s;
}

async function logAll(s: LobbyScenario, now: string, except: string[] = []) {
  for (const m of s.members) {
    if (except.includes(m.user.id)) continue;
    const res = await it_.request('/v1/entries', { as: m, json: { habitId: m.habit.id }, now });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
  }
}

async function latestPeriod(towerId: string) {
  const rows = await db.select().from(towerPeriods).where(eq(towerPeriods.towerId, towerId));
  return rows.sort((a, b) => b.periodStart.localeCompare(a.periodStart))[0]!;
}

async function evaluate(towerId: string, periodId: string, now: string) {
  return it_.request(`/v1/internal/towers/${towerId}/periods/${periodId}/evaluate`, {
    method: 'POST',
    as: internal,
    now,
  });
}

async function ok(res: Response): Promise<EvaluationResponse> {
  expect(res.status, await res.clone().text()).toBe(200);
  return evaluationResponseSchema.parse(await res.json());
}

/** Day N (1-based from 2026-11-16): noon and the instant its grace closes. */
const day = (n: number) => {
  const d = new Date(Date.UTC(2026, 10, 15 + n));
  const date = d.toISOString().slice(0, 10);
  const next = new Date(d.getTime() + 86_400_000).toISOString().slice(0, 10);
  return { date, noon: `${date}T19:00:00.000Z`, closed: `${next}T07:00:00.000Z` };
};

describe('POST /v1/internal/towers/:towerId/periods/:periodId/evaluate', () => {
  it('survives when everyone logged: writes the outcome, grows the run, materialises the next period', async () => {
    const s = await started();
    await logAll(s, day(1).noon);
    const p1 = await latestPeriod(s.tower.id);
    const body = await ok(await evaluate(s.tower.id, p1.id, day(1).closed));
    expect(body.outcome).toBe('survived');
    expect(body.period).toMatchObject({
      id: p1.id,
      state: 'evaluated',
      outcome: 'survived',
      evaluatedAt: day(1).closed,
    });
    expect(body.tower).toEqual({ height: 1, currentStreak: 1 });
    expect(body.nextPeriod).toMatchObject({ periodStart: day(2).date, state: 'pending' });
    expect(body.baseBlock).toBeNull();
    expect(body.transitions).toEqual([]);
    expect((await verifyTower(db, s.tower.id)).ok).toBe(true);
  });

  it('survives early (before evaluateAt) once everyone has met quota', async () => {
    const s = await started();
    await logAll(s, day(1).noon);
    const p1 = await latestPeriod(s.tower.id);
    const body = await ok(await evaluate(s.tower.id, p1.id, `${day(1).date}T20:00:00.000Z`));
    expect(body.outcome).toBe('survived');
  });

  it('rejects a period that is not yet decided (409 period_not_due) and writes nothing', async () => {
    const s = await started();
    await logAll(s, day(1).noon, [s.members[1]!.user.id]);
    const p1 = await latestPeriod(s.tower.id);
    const res = await evaluate(s.tower.id, p1.id, `${day(1).date}T20:00:00.000Z`);
    expect(res.status).toBe(409);
    expect((await readErrorBody(res)).error.code).toBe('period_not_due');
    expect((await latestPeriod(s.tower.id)).state).toBe('pending');
  });

  it('collapses on a first miss: block with both rosters and no blame, at_risk, streak reset, next period', async () => {
    const s = await started();
    const [a, b] = s.members;
    for (const n of [1, 2, 3]) {
      await logAll(s, day(n).noon);
      await ok(await evaluate(s.tower.id, (await latestPeriod(s.tower.id)).id, day(n).closed));
    }
    await logAll(s, day(4).noon, [b!.user.id]);
    const p4 = await latestPeriod(s.tower.id);
    const body = await ok(await evaluate(s.tower.id, p4.id, day(4).closed));

    expect(body.outcome).toBe('collapsed');
    expect(body.tower).toEqual({ height: 0, currentStreak: 0 });
    expect(body.baseBlock).toMatchObject({
      ordinal: 1,
      runStartDate: day(1).date,
      runEndDate: day(3).date,
      blockHeight: 3,
    });
    const roster = body.baseBlock!.roster;
    expect(roster.map((m) => m.user_id).sort()).toEqual([a!.user.id, b!.user.id].sort());
    for (const m of roster)
      expect(m).toMatchObject({
        qualifying_days: 3,
        total_days: 3,
        periods_present: 3,
        was_dormant: false,
      });
    expect(Object.keys(roster[0]!).sort()).toEqual([
      'display_name',
      'highest_tier',
      'periods_present',
      'qualifying_days',
      'total_days',
      'user_id',
      'was_dormant',
    ]);
    expect(JSON.stringify(body)).not.toMatch(/missed|caused|blame/i);

    expect(body.transitions).toEqual([
      expect.objectContaining({ membershipId: b!.membership.id, to: 'at_risk' }),
    ]);
    const [bRow] = await db.select().from(memberships).where(eq(memberships.id, b!.membership.id));
    expect(bRow).toMatchObject({ state: 'at_risk', consecutiveMissedPeriods: 1 });
    expect(body.nextPeriod?.periodStart).toBe(day(5).date);
    expect((await verifyTower(db, s.tower.id)).ok).toBe(true);
  });

  it('a second consecutive miss makes the member dormant instead of collapsing again', async () => {
    const s = await started();
    const b = s.members[1]!;
    await logAll(s, day(1).noon, [b.user.id]);
    await ok(await evaluate(s.tower.id, (await latestPeriod(s.tower.id)).id, day(1).closed)); // collapse, b at_risk
    await logAll(s, day(2).noon, [b.user.id]);
    const body = await ok(
      await evaluate(s.tower.id, (await latestPeriod(s.tower.id)).id, day(2).closed)
    );
    expect(body.outcome).toBe('survived');
    expect(body.tower).toEqual({ height: 1, currentStreak: 1 });
    expect(body.transitions).toEqual([
      expect.objectContaining({
        membershipId: b.membership.id,
        to: 'dormant',
        dormancyReason: 'consecutive_miss',
      }),
    ]);
    const [bRow] = await db.select().from(memberships).where(eq(memberships.id, b.membership.id));
    expect(bRow).toMatchObject({ state: 'dormant', dormancyReason: 'consecutive_miss' });
    // The tower carries on with one active member.
    await logAll(s, day(3).noon, [b.user.id]);
    const next = await ok(
      await evaluate(s.tower.id, (await latestPeriod(s.tower.id)).id, day(3).closed)
    );
    expect(next.outcome).toBe('survived');
    expect(next.tower.height).toBe(2);
  });

  it('hibernates (no height change) when no live member remains', async () => {
    const s = await started();
    for (const m of s.members) {
      await db
        .update(memberships)
        .set({ state: 'dormant', dormantSince: it_.clock.now, dormancyReason: 'consecutive_miss' })
        .where(eq(memberships.id, m.membership.id));
    }
    const body = await ok(
      await evaluate(s.tower.id, (await latestPeriod(s.tower.id)).id, day(1).closed)
    );
    expect(body.outcome).toBe('hibernated');
    expect(body.tower).toEqual({ height: 0, currentStreak: 0 });
    expect(body.nextPeriod?.periodStart).toBe(day(2).date);
    expect((await verifyTower(db, s.tower.id)).ok).toBe(true);
  });

  it('leaves a sub-minimum run with no block on collapse', async () => {
    const s = await started();
    const b = s.members[1]!;
    await logAll(s, day(1).noon);
    await ok(await evaluate(s.tower.id, (await latestPeriod(s.tower.id)).id, day(1).closed));
    await logAll(s, day(2).noon, [b.user.id]);
    const body = await ok(
      await evaluate(s.tower.id, (await latestPeriod(s.tower.id)).id, day(2).closed)
    );
    expect(body.outcome).toBe('collapsed');
    expect(body.baseBlock).toBeNull();
    expect((await verifyTower(db, s.tower.id)).ok).toBe(true);
  });

  it('refuses to re-evaluate (409 period_already_evaluated with the persisted outcome) and writes nothing', async () => {
    const s = await started();
    await logAll(s, day(1).noon);
    const p1 = await latestPeriod(s.tower.id);
    await ok(await evaluate(s.tower.id, p1.id, day(1).closed));
    const res = await evaluate(s.tower.id, p1.id, day(2).closed);
    expect(res.status).toBe(409);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe('period_already_evaluated');
    expect(body.error.details).toMatchObject({ period: { id: p1.id, outcome: 'survived' } });
    const [tower] = await db.select().from(towers).where(eq(towers.id, s.tower.id));
    expect(tower!.height).toBe(1);
    expect(
      await db
        .select()
        .from(towerPeriods)
        .where(and(eq(towerPeriods.towerId, s.tower.id)))
    ).toHaveLength(2);
  });

  it('is 404 for an unknown period or a period of another tower, and 401 without the token', async () => {
    const s = await started();
    const p1 = await latestPeriod(s.tower.id);
    expect((await evaluate(s.tower.id, crypto.randomUUID(), day(1).closed)).status).toBe(404);
    expect((await evaluate(crypto.randomUUID(), p1.id, day(1).closed)).status).toBe(404);
    const res = await it_.request(`/v1/internal/towers/${s.tower.id}/periods/${p1.id}/evaluate`, {
      method: 'POST',
      as: s.host,
    });
    expect(res.status).toBe(401);
  });
});
