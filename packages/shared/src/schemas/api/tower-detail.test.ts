import { describe, expect, it } from 'vitest';
import { towerDetailResponseSchema, towerListResponseSchema } from '../index.js';

/*
 * 2.13: GET /towers/:id returns different shapes for a lobby and an active
 * tower. Both are member-only; a non-member gets 404, so neither shape ever
 * reaches a stranger.
 */

const TOWER = {
  id: '1b2e4c1a-0d6f-4f7e-8a3b-2c5d6e7f8a90',
  hostId: '3f1c6d32-6a4e-4a9e-bb1f-8f0f5a4f2c11',
  name: 'Morning crew',
  periodUnit: 'day',
  periodLength: 1,
  quota: 1,
  deadlineTime: '22:00:00',
  timezone: 'America/Edmonton',
  weekResetDay: null,
  joinCode: 'ABCD2345',
  wobbleLeadMinutes: 120,
  nudgeLeadMinutes: 240,
  graceWindowMinutes: 120,
  lifecycle: 'draft',
  height: 0,
  currentStreak: 0,
  startedAt: null,
  createdAt: '2026-01-01T12:00:00.000Z',
};

const MEMBER = {
  membershipId: '2b2e4c1a-0d6f-4f7e-8a3b-2c5d6e7f8a90',
  userId: TOWER.hostId,
  displayName: 'Max',
  habitId: '9b2e4c1a-0d6f-4f7e-8a3b-2c5d6e7f8a90',
  habitName: 'Run',
  habitType: 'binary',
  state: 'active',
  joinedAt: '2026-01-01T12:00:00.000Z',
};

const PERIOD = {
  id: '4b2e4c1a-0d6f-4f7e-8a3b-2c5d6e7f8a90',
  towerId: TOWER.id,
  periodStart: '2026-01-02',
  periodEnd: '2026-01-02',
  deadlineAt: '2026-01-03T05:00:00.000Z',
  evaluateAt: '2026-01-03T07:00:00.000Z',
  state: 'pending',
  outcome: null,
  evaluatedAt: null,
  claimedAt: null,
  attempts: 0,
  freebieSource: null,
  freebieGrantedBy: null,
  createdAt: '2026-01-01T12:00:00.000Z',
};

describe('towerDetailResponseSchema', () => {
  it('accepts the lobby shape: tower, members, role and the join code', () => {
    const r = towerDetailResponseSchema.safeParse({
      kind: 'lobby',
      tower: TOWER,
      members: [MEMBER],
      role: 'host',
      joinCode: 'ABCD2345',
    });
    expect(r.success).toBe(true);
  });

  it('accepts the active shape: no join code, with the current period and blocks', () => {
    const r = towerDetailResponseSchema.safeParse({
      kind: 'active',
      tower: {
        ...TOWER,
        lifecycle: 'active',
        startedAt: '2026-01-02T07:00:00.000Z',
        height: 3,
        currentStreak: 3,
      },
      members: [MEMBER],
      role: 'member',
      currentPeriod: PERIOD,
      blocks: [],
      soloActive: false,
    });
    expect(r.success).toBe(true);
    expect(r.success && 'joinCode' in r.data).toBe(false);
  });

  it('rejects a lobby shape carrying active-only fields, and vice versa', () => {
    expect(
      towerDetailResponseSchema.safeParse({
        kind: 'lobby',
        tower: TOWER,
        members: [MEMBER],
        role: 'host',
        joinCode: 'ABCD2345',
        blocks: [],
      }).success
    ).toBe(false);
    expect(
      towerDetailResponseSchema.safeParse({
        kind: 'active',
        tower: TOWER,
        members: [MEMBER],
        role: 'host',
        joinCode: 'ABCD2345',
        currentPeriod: null,
        blocks: [],
      }).success
    ).toBe(false);
  });
});

describe('towerListResponseSchema', () => {
  it('lists towers with the caller’s membership state', () => {
    const r = towerListResponseSchema.safeParse({
      towers: [{ tower: TOWER, membershipState: 'active', memberCount: 2 }],
    });
    expect(r.success).toBe(true);
  });
});
