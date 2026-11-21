import { db, getMembership, memberships } from '@tower-of-habit/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { readErrorBody } from '../testing/harness.js';
import { useIntegrationApp } from '../testing/integration.js';

/*
 * 3.12: voluntary dormancy — POST / DELETE /towers/:id/absence.
 *
 * Harness clock: 2026-11-16T19:00Z (Monday noon in Edmonton MST).
 * Tower defaults: deadlineTime 22:00, timezone America/Edmonton.
 * Deadline: 2026-11-17T05:00Z (22:00 MST). Today tower-local: 2026-11-16.
 */

const it_ = useIntegrationApp();

async function started() {
  const s = await it_.fixtures.lobby({ members: 2 });
  expect(
    (await it_.request(`/v1/towers/${s.tower.id}/start`, { method: 'POST', as: s.host })).status
  ).toBe(200);
  return s;
}

describe('POST /v1/towers/:id/absence', () => {
  it('transitions the declaring member to dormant/voluntary with the correct return date', async () => {
    const s = await started();
    const member = s.members[1]!;
    const res = await it_.request(`/v1/towers/${s.tower.id}/absence`, {
      as: member,
      json: { from: '2026-11-17', to: '2026-11-23' },
    });
    expect(res.status).toBe(200);
    const m = await getMembership(db, member.membership.id);
    expect(m!.state).toBe('dormant');
    expect(m!.dormancyReason).toBe('voluntary');
    // Return date is the day after the last day of absence.
    expect(m!.voluntaryReturnDate).toBe('2026-11-24');
  });

  it('rejects a declaration longer than 14 days', async () => {
    const s = await started();
    const member = s.members[1]!;
    const res = await it_.request(`/v1/towers/${s.tower.id}/absence`, {
      as: member,
      // 15 days inclusive (Nov 17 through Dec 1)
      json: { from: '2026-11-17', to: '2026-12-01' },
    });
    expect(res.status).toBe(409);
    expect((await readErrorBody(res)).error.code).toBe('absence_too_long');
  });

  it('rejects a declaration when the member already has an active voluntary absence', async () => {
    const s = await started();
    const member = s.members[1]!;
    // Simulate an existing voluntary absence directly in the DB.
    await db
      .update(memberships)
      .set({
        state: 'dormant',
        dormantSince: it_.clock.now,
        dormancyReason: 'voluntary',
        voluntaryReturnDate: '2026-11-25',
      })
      .where(eq(memberships.id, member.membership.id));
    const res = await it_.request(`/v1/towers/${s.tower.id}/absence`, {
      as: member,
      json: { from: '2026-11-25', to: '2026-11-30' },
    });
    expect(res.status).toBe(409);
    expect((await readErrorBody(res)).error.code).toBe('absence_already_active');
  });

  it('rejects a declaration that would exceed the 28-day annual budget', async () => {
    const s = await started();
    const member = s.members[1]!;
    // Two 14-day stints exhaust the 28-day annual budget.
    const res1 = await it_.request(`/v1/towers/${s.tower.id}/absence`, {
      as: member,
      json: { from: '2026-11-17', to: '2026-11-30' },
    });
    expect(res1.status).toBe(200);
    // Cancel the first to allow the second (concurrent cap).
    await it_.request(`/v1/towers/${s.tower.id}/absence`, { method: 'DELETE', as: member });
    const res2 = await it_.request(`/v1/towers/${s.tower.id}/absence`, {
      as: member,
      json: { from: '2026-12-01', to: '2026-12-14' },
    });
    expect(res2.status).toBe(200);
    // Cancel the second to allow the third attempt.
    await it_.request(`/v1/towers/${s.tower.id}/absence`, { method: 'DELETE', as: member });
    // Budget is now 28 days (14 + 14). Even 1 more day fails.
    const res3 = await it_.request(`/v1/towers/${s.tower.id}/absence`, {
      as: member,
      json: { from: '2026-12-15', to: '2026-12-15' },
    });
    expect(res3.status).toBe(409);
    expect((await readErrorBody(res3)).error.code).toBe('annual_budget_exceeded');
  });

  it('after the deadline, indicates the absence takes effect from the next period', async () => {
    const s = await started();
    const member = s.members[1]!;
    // Advance clock past the deadline (22:00 MST = 05:00Z next day).
    const afterDeadline = '2026-11-17T05:01:00.000Z';
    const res = await it_.request(`/v1/towers/${s.tower.id}/absence`, {
      as: member,
      now: afterDeadline,
      json: { from: '2026-11-17', to: '2026-11-23' },
    });
    expect(res.status).toBe(200);
    // The member should still be active for the current period — the
    // transition is deferred to the next period.
    const m = await getMembership(db, member.membership.id);
    expect(m!.state).toBe('active');
  });

  it('returns 404 to a non-member', async () => {
    const s = await started();
    const stranger = await it_.fixtures.user();
    const res = await it_.request(`/v1/towers/${s.tower.id}/absence`, {
      as: stranger,
      json: { from: '2026-11-17', to: '2026-11-23' },
    });
    expect(res.status).toBe(404);
  });

  it('returns 409 for a draft tower', async () => {
    const s = await it_.fixtures.lobby({ members: 2 });
    const res = await it_.request(`/v1/towers/${s.tower.id}/absence`, {
      as: s.host,
      json: { from: '2026-11-17', to: '2026-11-23' },
    });
    expect(res.status).toBe(409);
    expect((await readErrorBody(res)).error.code).toBe('tower_not_started');
  });
});

describe('DELETE /v1/towers/:id/absence', () => {
  it('restores a voluntarily dormant member to active', async () => {
    const s = await started();
    const member = s.members[1]!;
    // Set up voluntary dormancy directly.
    await db
      .update(memberships)
      .set({
        state: 'dormant',
        dormantSince: it_.clock.now,
        dormancyReason: 'voluntary',
        voluntaryReturnDate: '2026-11-25',
      })
      .where(eq(memberships.id, member.membership.id));
    const res = await it_.request(`/v1/towers/${s.tower.id}/absence`, {
      method: 'DELETE',
      as: member,
    });
    expect(res.status).toBe(204);
    const m = await getMembership(db, member.membership.id);
    expect(m!.state).toBe('active');
    expect(m!.dormancyReason).toBeNull();
    expect(m!.voluntaryReturnDate).toBeNull();
  });

  it('rejects cancellation when the member has no active voluntary absence', async () => {
    const s = await started();
    const member = s.members[1]!;
    const res = await it_.request(`/v1/towers/${s.tower.id}/absence`, {
      method: 'DELETE',
      as: member,
    });
    expect(res.status).toBe(409);
    expect((await readErrorBody(res)).error.code).toBe('no_active_absence');
  });

  it('returns 404 to a non-member', async () => {
    const s = await started();
    const stranger = await it_.fixtures.user();
    const res = await it_.request(`/v1/towers/${s.tower.id}/absence`, {
      method: 'DELETE',
      as: stranger,
    });
    expect(res.status).toBe(404);
  });
});
