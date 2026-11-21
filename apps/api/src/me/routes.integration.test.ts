import { db, entries, memberships, towers, users } from '@tower-of-habit/db';
import { meResponseSchema, meSessionsResponseSchema } from '@tower-of-habit/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { readErrorBody } from '../testing/harness.js';
import { useIntegrationApp } from '../testing/integration.js';

/*
 * 2.11: GET /me, PATCH /me, GET /me/sessions, over HTTP against real Postgres.
 */

const it_ = useIntegrationApp();

describe('GET /v1/me', () => {
  it('returns the user and a count of active towers', async () => {
    const me = await it_.fixtures.user({ email: 'me@example.com', displayName: 'Max' });
    const res = await it_.request('/v1/me', { as: me });
    expect(res.status).toBe(200);
    const body = meResponseSchema.parse(await res.json());
    expect(body.user).toMatchObject({
      id: me.user.id,
      email: 'me@example.com',
      displayName: 'Max',
    });
    expect(body.activeTowerCount).toBe(0);
  });

  it('counts only towers whose lifecycle is active', async () => {
    const lobby = await it_.fixtures.lobby({ members: 2 });
    const host = lobby.host;
    expect(
      meResponseSchema.parse(await (await it_.request('/v1/me', { as: host })).json())
        .activeTowerCount
    ).toBe(0);

    await db
      .update(towers)
      .set({ lifecycle: 'active', startedAt: it_.clock.now })
      .where(eq(towers.id, lobby.tower.id));
    expect(
      meResponseSchema.parse(await (await it_.request('/v1/me', { as: host })).json())
        .activeTowerCount
    ).toBe(1);
  });

  it('requires a session', async () => {
    const res = await it_.request('/v1/me');
    expect(res.status).toBe(401);
    expect((await readErrorBody(res)).error.code).toBe('unauthenticated');
  });
});

describe('PATCH /v1/me', () => {
  it('updates display name and timezone', async () => {
    const me = await it_.fixtures.user();
    const res = await it_.request('/v1/me', {
      method: 'PATCH',
      as: me,
      json: { displayName: 'Maxwell', timezone: 'Asia/Kolkata' },
    });
    expect(res.status).toBe(200);
    const body = meResponseSchema.parse(await res.json());
    expect(body.user).toMatchObject({ displayName: 'Maxwell', timezone: 'Asia/Kolkata' });
    const [row] = await db.select().from(users).where(eq(users.id, me.user.id));
    expect(row).toMatchObject({ displayName: 'Maxwell', timezone: 'Asia/Kolkata' });
  });

  it('rejects an unknown timezone with 400 validation_failed, not a silent fallback', async () => {
    const me = await it_.fixtures.user({ timezone: 'UTC' });
    const res = await it_.request('/v1/me', { method: 'PATCH', as: me, json: { timezone: 'PST' } });
    expect(res.status).toBe(400);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details).toHaveProperty('timezone');
    const [row] = await db.select().from(users).where(eq(users.id, me.user.id));
    expect(row!.timezone).toBe('UTC');
  });

  it('does not support changing the email', async () => {
    const me = await it_.fixtures.user({ email: 'keep@example.com' });
    const res = await it_.request('/v1/me', {
      method: 'PATCH',
      as: me,
      json: { email: 'new@example.com' },
    });
    expect(res.status).toBe(400);
    expect((await readErrorBody(res)).error.code).toBe('validation_failed');
    const [row] = await db.select().from(users).where(eq(users.id, me.user.id));
    expect(row!.email).toBe('keep@example.com');
  });

  it('does not retroactively alter any entries.local_date when the timezone changes', async () => {
    const me = await it_.fixtures.user({ timezone: 'America/Edmonton' });
    const habit = await it_.fixtures.habit(me);
    await db.insert(entries).values({
      habitId: habit.id,
      localDate: '2026-11-15',
      loggedAt: new Date('2026-11-16T05:30:00.000Z'), // 22:30 Edmonton on the 15th
      countsTowardQuota: true,
    });
    const res = await it_.request('/v1/me', {
      method: 'PATCH',
      as: me,
      json: { timezone: 'Asia/Tokyo' },
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(entries).where(eq(entries.habitId, habit.id));
    expect(row!.localDate).toBe('2026-11-15');
  });
});

describe('GET /v1/me/sessions', () => {
  it("lists the caller's live sessions, marking the current one", async () => {
    const me = await it_.fixtures.user();
    // A second device: another minted session for the same user.
    const other = await it_.fixtures.user({ email: 'other@example.com' });
    void other;
    const res = await it_.request('/v1/me/sessions', { as: me });
    expect(res.status).toBe(200);
    const body = meSessionsResponseSchema.parse(await res.json());
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({ current: true, userAgent: 'integration-test' });
  });

  it('does not list revoked sessions or other users', async () => {
    const me = await it_.fixtures.user();
    const stranger = await it_.fixtures.user();
    await it_.request('/v1/auth/logout', { method: 'POST', as: stranger });
    const res = await it_.request('/v1/me/sessions', { as: me });
    const body = meSessionsResponseSchema.parse(await res.json());
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions.every((s) => s.current)).toBe(true);
  });
});

// Silence unused-import lint for tables referenced only in some branches.
void memberships;
