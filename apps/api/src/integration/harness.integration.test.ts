import { db, sessions, users } from '@tower-of-habit/db';
import { count } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { TEST_NOW_HEADER } from '../context.js';
import { useIntegrationApp } from '../testing/integration.js';

/*
 * 2.20: the integration harness itself, against the real Postgres from
 * Compose (.env.test). Every test starts from truncated tables, builds its
 * rows through the fixture builder, and talks to the app over HTTP with a
 * minted session. These tests prove the harness; the domain tickets' tests
 * build on it.
 */

const it_ = useIntegrationApp();

describe('integration harness', () => {
  it('starts each test from empty tables', async () => {
    const [row] = await db.select({ n: count() }).from(users);
    expect(row!.n).toBe(0);
    await it_.fixtures.user({ email: 'leftover@example.com' });
  });

  it("truncated the previous test's rows", async () => {
    const [row] = await db.select({ n: count() }).from(users);
    expect(row!.n).toBe(0);
  });

  it('mints a session for a fixture user that the real session middleware accepts', async () => {
    const alice = await it_.fixtures.user({ email: 'alice@example.com', timezone: 'UTC' });
    expect(alice.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const [row] = await db.select({ n: count() }).from(sessions);
    expect(row!.n).toBe(1);

    // /v1/auth/logout is the smallest authenticated route: 204 proves the
    // minted token resolved to a live session for this user.
    const res = await it_.request('/v1/auth/logout', { method: 'POST', as: alice });
    expect(res.status).toBe(204);

    const again = await it_.request('/v1/auth/logout', { method: 'POST', as: alice });
    expect(again.status).toBe(401);
  });

  it('builds a lobby scenario (users, habits, tower, memberships) in one call', async () => {
    const s = await it_.fixtures.lobby({ members: 2 });
    expect(s.tower.lifecycle).toBe('draft');
    expect(s.members).toHaveLength(2);
    expect(s.members[0]!.user.id).toBe(s.tower.hostId);
    for (const m of s.members) {
      expect(m.habit.ownerId).toBe(m.user.id);
      expect(m.membership.towerId).toBe(s.tower.id);
      expect(m.membership.habitId).toBe(m.habit.id);
      expect(typeof m.token).toBe('string');
    }
  });

  it('captures login codes in the in-memory sink instead of the log', async () => {
    const res = await it_.request('/v1/auth/request-code', {
      method: 'POST',
      json: { email: 'otp@example.com' },
    });
    expect(res.status).toBe(202);
    expect(it_.sentCodes()).toEqual([
      { email: 'otp@example.com', code: expect.stringMatching(/^\d{6}$/) },
    ]);
    expect(it_.logger.lines.some((l) => 'code' in l)).toBe(false);

    const code = it_.sentCodes()[0]!.code;
    const verified = await it_.request('/v1/auth/verify-code', {
      method: 'POST',
      json: { email: 'otp@example.com', code, timezone: 'America/Edmonton' },
    });
    expect(verified.status).toBe(200);
  });

  it('honours X-Test-Now through the real app', async () => {
    const alice = await it_.fixtures.user();
    const at = '2027-03-14T09:00:00.000Z';
    const res = await it_.request('/v1/auth/logout', {
      method: 'POST',
      as: alice,
      now: at,
    });
    expect(res.status).toBe(204);
    // The harness sets the header by default from its clock; an explicit `now`
    // overrides it per call.
    expect(it_.lastRequestHeaders()?.[TEST_NOW_HEADER]).toBe(at);
  });
});
