import { db, habits, memberships, towers } from '@tower-of-habit/db';
import { towerDetailResponseSchema } from '@tower-of-habit/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { readErrorBody } from '../testing/harness.js';
import { useIntegrationApp } from '../testing/integration.js';

/*
 * 2.14: join by code, leave, remove.
 */

const it_ = useIntegrationApp();

async function membershipRows(towerId: string) {
  return db.select().from(memberships).where(eq(memberships.towerId, towerId));
}

describe('POST /v1/towers/join', () => {
  it('joins a lobby tower with the caller’s habit, case-insensitively', async () => {
    const s = await it_.fixtures.lobby({ members: 1 });
    const joiner = await it_.fixtures.user({ displayName: 'Jo' });
    const habit = await it_.fixtures.habit(joiner, { name: 'Read' });
    const res = await it_.request('/v1/towers/join', {
      as: joiner,
      json: { joinCode: s.tower.joinCode.toLowerCase(), habitId: habit.id },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const body = towerDetailResponseSchema.parse(await res.json());
    expect(body.kind).toBe('lobby');
    expect(body.role).toBe('member');
    expect(body.members.map((m) => m.userId)).toEqual([s.host.user.id, joiner.user.id]);
    expect(body.members[1]).toMatchObject({
      displayName: 'Jo',
      habitId: habit.id,
      habitName: 'Read',
    });
  });

  it('returns 404 for an unknown code', async () => {
    const joiner = await it_.fixtures.user();
    const habit = await it_.fixtures.habit(joiner);
    const res = await it_.request('/v1/towers/join', {
      as: joiner,
      json: { joinCode: 'ZZZZ9999', habitId: habit.id },
    });
    expect(res.status).toBe(404);
    expect((await readErrorBody(res)).error.code).toBe('not_found');
  });

  it('rejects a tower that is not in the lobby (409 tower_not_joinable)', async () => {
    const s = await it_.fixtures.lobby({ members: 1 });
    await db
      .update(towers)
      .set({ lifecycle: 'active', startedAt: it_.clock.now })
      .where(eq(towers.id, s.tower.id));
    const joiner = await it_.fixtures.user();
    const habit = await it_.fixtures.habit(joiner);
    const res = await it_.request('/v1/towers/join', {
      as: joiner,
      json: { joinCode: s.tower.joinCode, habitId: habit.id },
    });
    expect(res.status).toBe(409);
    expect((await readErrorBody(res)).error.code).toBe('tower_not_joinable');
  });

  it('requires the caller to own the habit (404)', async () => {
    const s = await it_.fixtures.lobby({ members: 1 });
    const joiner = await it_.fixtures.user();
    const res = await it_.request('/v1/towers/join', {
      as: joiner,
      json: { joinCode: s.tower.joinCode, habitId: s.host.habit.id },
    });
    expect(res.status).toBe(404);
  });

  it('requires the habit cadence to equal the tower cadence (409 habit_cadence_mismatch)', async () => {
    const s = await it_.fixtures.lobby({ members: 1 });
    const joiner = await it_.fixtures.user();
    const habit = await it_.fixtures.habit(joiner);
    await db.update(habits).set({ periodUnit: 'week' }).where(eq(habits.id, habit.id));
    const res = await it_.request('/v1/towers/join', {
      as: joiner,
      json: { joinCode: s.tower.joinCode, habitId: habit.id },
    });
    expect(res.status).toBe(409);
    expect((await readErrorBody(res)).error.code).toBe('habit_cadence_mismatch');
  });

  it('rejects a habit already bound to another non-collapsed tower (409 habit_already_committed)', async () => {
    const a = await it_.fixtures.lobby({ members: 1 });
    const b = await it_.fixtures.lobby({ members: 1 });
    const res = await it_.request('/v1/towers/join', {
      as: a.host,
      json: { joinCode: b.tower.joinCode, habitId: a.host.habit.id },
    });
    expect(res.status).toBe(409);
    expect((await readErrorBody(res)).error.code).toBe('habit_already_committed');
  });

  it('rejects joining a tower the caller is already in (409 already_member)', async () => {
    const s = await it_.fixtures.lobby({ members: 1 });
    const second = await it_.fixtures.habit(s.host, { name: 'Second' });
    const res = await it_.request('/v1/towers/join', {
      as: s.host,
      json: { joinCode: s.tower.joinCode, habitId: second.id },
    });
    expect(res.status).toBe(409);
    expect((await readErrorBody(res)).error.code).toBe('already_member');
  });
});

describe('DELETE /v1/towers/:id/memberships/:membershipId', () => {
  it('lets a member remove themselves in the lobby, freeing the habit', async () => {
    const s = await it_.fixtures.lobby({ members: 2 });
    const leaver = s.members[1]!;
    const res = await it_.request(`/v1/towers/${s.tower.id}/memberships/${leaver.membership.id}`, {
      method: 'DELETE',
      as: leaver,
    });
    expect(res.status).toBe(204);
    expect((await membershipRows(s.tower.id)).map((m) => m.id)).toEqual([s.host.membership.id]);
    // The habit can be bound again.
    const other = await it_.fixtures.lobby({ members: 1 });
    const rejoin = await it_.request('/v1/towers/join', {
      as: leaver,
      json: { joinCode: other.tower.joinCode, habitId: leaver.habit.id },
    });
    expect(rejoin.status).toBe(201);
    // And the leaver can no longer see the tower.
    expect((await it_.request(`/v1/towers/${s.tower.id}`, { as: leaver })).status).toBe(404);
  });

  it('lets the creator remove another member, but not a non-creator (403)', async () => {
    const s = await it_.fixtures.lobby({ members: 3 });
    const [, b, c] = s.members;
    const forbidden = await it_.request(
      `/v1/towers/${s.tower.id}/memberships/${c!.membership.id}`,
      { method: 'DELETE', as: b! }
    );
    expect(forbidden.status).toBe(403);
    expect((await readErrorBody(forbidden)).error.code).toBe('forbidden');
    const ok = await it_.request(`/v1/towers/${s.tower.id}/memberships/${c!.membership.id}`, {
      method: 'DELETE',
      as: s.host,
    });
    expect(ok.status).toBe(204);
    expect((await membershipRows(s.tower.id)).map((m) => m.id).sort()).toEqual(
      [s.host.membership.id, b!.membership.id].sort()
    );
  });

  it('refuses the creator leaving while others remain (409 creator_cannot_leave)', async () => {
    const s = await it_.fixtures.lobby({ members: 2 });
    const res = await it_.request(`/v1/towers/${s.tower.id}/memberships/${s.host.membership.id}`, {
      method: 'DELETE',
      as: s.host,
    });
    expect(res.status).toBe(409);
    expect((await readErrorBody(res)).error.code).toBe('creator_cannot_leave');
  });

  it('disbands the lobby when the creator leaves alone', async () => {
    const s = await it_.fixtures.lobby({ members: 1 });
    const res = await it_.request(`/v1/towers/${s.tower.id}/memberships/${s.host.membership.id}`, {
      method: 'DELETE',
      as: s.host,
    });
    expect(res.status).toBe(204);
    expect(await db.select().from(towers).where(eq(towers.id, s.tower.id))).toEqual([]);
  });

  it('is 404 to a non-member and for an unknown membership', async () => {
    const s = await it_.fixtures.lobby({ members: 2 });
    const stranger = await it_.fixtures.user();
    expect(
      (
        await it_.request(`/v1/towers/${s.tower.id}/memberships/${s.host.membership.id}`, {
          method: 'DELETE',
          as: stranger,
        })
      ).status
    ).toBe(404);
    expect(
      (
        await it_.request(`/v1/towers/${s.tower.id}/memberships/${crypto.randomUUID()}`, {
          method: 'DELETE',
          as: s.host,
        })
      ).status
    ).toBe(404);
  });

  it('refuses removal once the tower has started (409 tower_not_in_lobby)', async () => {
    const s = await it_.fixtures.lobby({ members: 2 });
    await db
      .update(towers)
      .set({ lifecycle: 'active', startedAt: it_.clock.now })
      .where(eq(towers.id, s.tower.id));
    const res = await it_.request(
      `/v1/towers/${s.tower.id}/memberships/${s.members[1]!.membership.id}`,
      { method: 'DELETE', as: s.host }
    );
    expect(res.status).toBe(409);
    expect((await readErrorBody(res)).error.code).toBe('tower_not_in_lobby');
  });
});
