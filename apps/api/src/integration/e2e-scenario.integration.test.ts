import { db, memberships, towerPeriods } from '@tower-of-habit/db';
import {
  evaluationResponseSchema,
  habitDetailResponseSchema,
  logEntryResponseSchema,
  periodPreviewResponseSchema,
  towerDetailResponseSchema,
  towerListResponseSchema,
  verifyCodeResponseSchema,
  type EvaluationResponse,
} from '@tower-of-habit/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { useIntegrationApp } from '../testing/integration.js';

/*
 * 2.21: the Phase 2 definition-of-done walk-through. Two users authenticate via
 * OTP, create habits, build a tower, log entries over several days, survive,
 * collapse, produce a base block, and recover from dormancy — all through the
 * HTTP API and the internal evaluation endpoint.
 *
 * Clock: 2026-11-16T19:00Z (noon Edmonton). Tower deadline 22:00 MST = 05:00Z
 * next day; wobbleAt 03:00Z; evaluateAt 07:00Z.
 */

const TOKEN = 'e2e-internal-token';
const it_ = useIntegrationApp({ internalApiToken: TOKEN });
const internal = { token: TOKEN };

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Day N (1-based from 2026-11-16): noon and the instant its grace closes. */
const day = (n: number) => {
  const d = new Date(Date.UTC(2026, 10, 15 + n));
  const date = d.toISOString().slice(0, 10);
  const next = new Date(d.getTime() + 86_400_000).toISOString().slice(0, 10);
  return { date, noon: `${date}T19:00:00.000Z`, closed: `${next}T07:00:00.000Z` };
};

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

/** Walk the full OTP flow and return an actor-shaped object. */
async function authenticateViaOtp(
  email: string,
  timezone = 'America/Edmonton'
): Promise<{ user: { id: string; email: string }; token: string }> {
  const reqRes = await it_.request('/v1/auth/request-code', { json: { email } });
  expect(reqRes.status).toBe(202);
  const sent = it_.sentCodes().find((c) => c.email === email);
  expect(sent, `no code sent to ${email}`).toBeDefined();
  const verRes = await it_.request('/v1/auth/verify-code', {
    json: { email, code: sent!.code, timezone },
  });
  expect(verRes.status, await verRes.clone().text()).toBe(200);
  const body = verifyCodeResponseSchema.parse(await verRes.json());
  return { user: { id: body.user.id, email: body.user.email }, token: body.token };
}

// ── The test ────────────────────────────────────────────────────────────────

describe('Phase 2 end-to-end scenario', () => {
  it('walks the full Phase 2 definition of done', async () => {
    // ── Stage 1: OTP auth, create habits, form tower, start it ──────────

    const alice = await authenticateViaOtp('alice@e2e.test');
    const bob = await authenticateViaOtp('bob@e2e.test');
    const charlie = await authenticateViaOtp('charlie@e2e.test');

    // Create habits via the API (not fixtures).
    const habitARes = await it_.request('/v1/habits', {
      as: alice,
      json: { name: 'Run', type: 'binary' },
    });
    expect(habitARes.status).toBe(201);
    const habitA = habitDetailResponseSchema.parse(await habitARes.json()).habit;

    const habitBRes = await it_.request('/v1/habits', {
      as: bob,
      json: { name: 'Read', type: 'binary' },
    });
    expect(habitBRes.status).toBe(201);
    const habitB = habitDetailResponseSchema.parse(await habitBRes.json()).habit;

    // Charlie creates a habit but is never invited to the tower.
    const habitCRes = await it_.request('/v1/habits', {
      as: charlie,
      json: { name: 'Meditate', type: 'binary' },
    });
    expect(habitCRes.status).toBe(201);
    const habitC = habitDetailResponseSchema.parse(await habitCRes.json()).habit;

    // Alice creates a tower.
    const towerRes = await it_.request('/v1/towers', {
      as: alice,
      json: {
        name: 'E2E Tower',
        deadlineTime: '22:00',
        timezone: 'America/Edmonton',
        habitId: habitA.id,
      },
    });
    expect(towerRes.status).toBe(201);
    const towerBody = towerDetailResponseSchema.parse(await towerRes.json());
    expect(towerBody.kind).toBe('lobby');
    if (towerBody.kind !== 'lobby') throw new Error('expected lobby');
    const towerId = towerBody.tower.id;
    const joinCode = towerBody.joinCode;

    // Bob joins.
    const joinRes = await it_.request('/v1/towers/join', {
      as: bob,
      json: { joinCode, habitId: habitB.id },
    });
    expect(joinRes.status, await joinRes.clone().text()).toBe(201);

    // Alice starts the tower.
    const startRes = await it_.request(`/v1/towers/${towerId}/start`, {
      method: 'POST',
      as: alice,
    });
    expect(startRes.status, await startRes.clone().text()).toBe(200);
    const startBody = towerDetailResponseSchema.parse(await startRes.json());
    expect(startBody.kind).toBe('active');
    if (startBody.kind !== 'active') throw new Error('expected active');
    expect(startBody.currentPeriod?.periodStart).toBe(day(1).date);

    // Capture membership IDs for later assertions.
    const aliceMembership = startBody.members.find((m) => m.userId === alice.user.id)!;
    const bobMembership = startBody.members.find((m) => m.userId === bob.user.id)!;
    expect(aliceMembership).toBeDefined();
    expect(bobMembership).toBeDefined();

    // ── Stage 1b: Outsider isolation — Charlie cannot see or affect the tower

    // Tower detail is hidden from non-members (404, not 403).
    expect((await it_.request(`/v1/towers/${towerId}`, { as: charlie })).status).toBe(404);

    // Tower list doesn't include the tower for non-members.
    const charlieListRes = await it_.request('/v1/towers', { as: charlie });
    expect(charlieListRes.status).toBe(200);
    const charlieList = towerListResponseSchema.parse(await charlieListRes.json());
    expect(charlieList.towers.map((t) => t.tower.id)).not.toContain(towerId);

    // Period preview is hidden from non-members.
    expect((await it_.request(`/v1/towers/${towerId}/period`, { as: charlie })).status).toBe(404);

    // Non-member cannot start the tower (sees 404, not "already active").
    expect(
      (await it_.request(`/v1/towers/${towerId}/start`, { method: 'POST', as: charlie })).status
    ).toBe(404);

    // Charlie can log their own standalone habit (succeeds), but it has no
    // effect on the tower — verified implicitly: the tower evaluation in
    // stage 2 checks height/streak/transitions match only Alice and Bob's logs.
    const charlieLog = await it_.request('/v1/entries', {
      as: charlie,
      json: { habitId: habitC.id },
      now: day(1).noon,
    });
    expect(charlieLog.status, await charlieLog.clone().text()).toBeLessThan(300);

    // ── Stage 2: Both log day 1 → survived, height 1, streak 1 ─────────

    const logA1 = await it_.request('/v1/entries', {
      as: alice,
      json: { habitId: habitA.id },
      now: day(1).noon,
    });
    expect(logA1.status, await logA1.clone().text()).toBeLessThan(300);
    expect(logEntryResponseSchema.parse(await logA1.json()).qualifies).toBe(true);

    const logB1 = await it_.request('/v1/entries', {
      as: bob,
      json: { habitId: habitB.id },
      now: day(1).noon,
    });
    expect(logB1.status, await logB1.clone().text()).toBeLessThan(300);

    const p1 = await latestPeriod(towerId);
    const eval1 = await ok(await evaluate(towerId, p1.id, day(1).closed));
    expect(eval1.outcome).toBe('survived');
    expect(eval1.tower).toEqual({ height: 1, currentStreak: 1 });
    expect(eval1.nextPeriod).toMatchObject({ periodStart: day(2).date, state: 'pending' });
    expect(eval1.baseBlock).toBeNull();
    expect(eval1.transitions).toEqual([]);

    // ── Stage 3: Both log days 2 and 3 ─────────────────────────────────

    // Day 2
    for (const actor of [
      { as: alice, habitId: habitA.id },
      { as: bob, habitId: habitB.id },
    ]) {
      const res = await it_.request('/v1/entries', {
        as: actor.as,
        json: { habitId: actor.habitId },
        now: day(2).noon,
      });
      expect(res.status, await res.clone().text()).toBeLessThan(300);
    }
    const eval2 = await ok(
      await evaluate(towerId, (await latestPeriod(towerId)).id, day(2).closed)
    );
    expect(eval2.outcome).toBe('survived');
    expect(eval2.tower).toEqual({ height: 2, currentStreak: 2 });

    // Day 3
    for (const actor of [
      { as: alice, habitId: habitA.id },
      { as: bob, habitId: habitB.id },
    ]) {
      const res = await it_.request('/v1/entries', {
        as: actor.as,
        json: { habitId: actor.habitId },
        now: day(3).noon,
      });
      expect(res.status, await res.clone().text()).toBeLessThan(300);
    }
    const eval3 = await ok(
      await evaluate(towerId, (await latestPeriod(towerId)).id, day(3).closed)
    );
    expect(eval3.outcome).toBe('survived');
    expect(eval3.tower).toEqual({ height: 3, currentStreak: 3 });

    // ── Stage 4: B misses day 4 → wobbling → collapsed ─────────────────

    // Only Alice logs on day 4.
    const logA4 = await it_.request('/v1/entries', {
      as: alice,
      json: { habitId: habitA.id },
      now: day(4).noon,
    });
    expect(logA4.status, await logA4.clone().text()).toBeLessThan(300);

    // Period preview at wobbleAt: should show wobbling, naming Bob.
    const wobbleNow = '2026-11-20T03:30:00.000Z';
    const previewRes = await it_.request(`/v1/towers/${towerId}/period`, {
      as: alice,
      now: wobbleNow,
    });
    expect(previewRes.status, await previewRes.clone().text()).toBe(200);
    const preview = periodPreviewResponseSchema.parse(await previewRes.json());
    expect(preview.periodStatus).toBe('wobbling');
    expect(preview.outstanding).toContain(bobMembership.membershipId);
    expect(preview.outstanding).not.toContain(aliceMembership.membershipId);

    // Evaluate day 4 (past evaluateAt).
    const p4 = await latestPeriod(towerId);
    const eval4 = await ok(await evaluate(towerId, p4.id, day(4).closed));

    // ── Stage 5: Base block with heightDays = 3, correct roster, no blame

    expect(eval4.outcome).toBe('collapsed');
    expect(eval4.baseBlock).not.toBeNull();
    expect(eval4.baseBlock).toMatchObject({
      ordinal: 1,
      runStartDate: day(1).date,
      runEndDate: day(3).date,
      blockHeight: 3,
    });
    const roster = eval4.baseBlock!.roster;
    expect(roster).toHaveLength(2);
    expect(roster.map((m) => m.user_id).sort()).toEqual([alice.user.id, bob.user.id].sort());
    for (const m of roster) {
      expect(m).toMatchObject({
        qualifying_days: 3,
        total_days: 3,
        periods_present: 3,
        was_dormant: false,
      });
    }
    // Charlie (outsider) is not on the roster.
    expect(roster.map((m) => m.user_id)).not.toContain(charlie.user.id);
    // No blame field on the block (§2.6 criterion 5).
    expect(JSON.stringify(eval4.baseBlock)).not.toMatch(/missed|caused|blame/i);

    // ── Stage 6: B at_risk; height 0 (block preserves 3); streak 0 ─────

    expect(eval4.tower).toEqual({ height: 0, currentStreak: 0 });
    expect(eval4.transitions).toEqual([
      expect.objectContaining({ membershipId: bobMembership.membershipId, to: 'at_risk' }),
    ]);
    const [bobRow1] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.id, bobMembership.membershipId));
    expect(bobRow1).toMatchObject({ state: 'at_risk', consecutiveMissedPeriods: 1 });

    // ── Stage 7: B misses day 5 → dormant_auto, no second collapse ──────

    // Only Alice logs on day 5.
    const logA5 = await it_.request('/v1/entries', {
      as: alice,
      json: { habitId: habitA.id },
      now: day(5).noon,
    });
    expect(logA5.status, await logA5.clone().text()).toBeLessThan(300);

    const eval5 = await ok(
      await evaluate(towerId, (await latestPeriod(towerId)).id, day(5).closed)
    );
    // The second consecutive miss makes Bob dormant instead of collapsing again.
    expect(eval5.outcome).toBe('survived');
    expect(eval5.tower).toEqual({ height: 1, currentStreak: 1 });
    expect(eval5.transitions).toEqual([
      expect.objectContaining({
        membershipId: bobMembership.membershipId,
        to: 'dormant',
        dormancyReason: 'consecutive_miss',
      }),
    ]);
    const [bobRow2] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.id, bobMembership.membershipId));
    expect(bobRow2).toMatchObject({ state: 'dormant', dormancyReason: 'consecutive_miss' });

    // ── Stage 8: A continues alone; tower survives ──────────────────────

    const logA6 = await it_.request('/v1/entries', {
      as: alice,
      json: { habitId: habitA.id },
      now: day(6).noon,
    });
    expect(logA6.status, await logA6.clone().text()).toBeLessThan(300);

    const eval6 = await ok(
      await evaluate(towerId, (await latestPeriod(towerId)).id, day(6).closed)
    );
    expect(eval6.outcome).toBe('survived');
    expect(eval6.tower).toEqual({ height: 2, currentStreak: 2 });

    // ── Stage 9: B logs on day 7 → returns to active, misses reset ──────

    const logB7 = await it_.request('/v1/entries', {
      as: bob,
      json: { habitId: habitB.id },
      now: day(7).noon,
    });
    expect(logB7.status, await logB7.clone().text()).toBeLessThan(300);
    const logB7Body = logEntryResponseSchema.parse(await logB7.json());
    expect(logB7Body.qualifies).toBe(true);

    // Bob should be active again with the miss counter reset.
    const [bobRow3] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.id, bobMembership.membershipId));
    expect(bobRow3).toMatchObject({
      state: 'active',
      consecutiveMissedPeriods: 0,
      dormantSince: null,
      dormancyReason: null,
    });
  });
});
