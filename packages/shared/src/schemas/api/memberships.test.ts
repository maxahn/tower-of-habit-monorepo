import { describe, expect, expectTypeOf, it } from 'vitest';
import { membershipResponseSchema, type MembershipResponse } from '../index.js';

// Mirrors Membership (towers/memberships/schema.ts). Joining goes through
// joinTowerRequestSchema (towers.test.ts); state changes are server-driven.

const ROW = {
  id: '7e6d5c4b-3a29-4180-9f8e-7d6c5b4a3928',
  towerId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  userId: '3f1c6d32-6a4e-4a9e-bb1f-8f0f5a4f2c11',
  habitId: '9b2e4c1a-0d6f-4f7e-8a3b-2c5d6e7f8a90',
  state: 'active',
  consecutiveMissedPeriods: 0,
  lastQualifyingDate: '2026-01-05',
  dormantSince: null,
  dormancyReason: null,
  voluntaryReturnDate: null,
  joinedAt: '2026-01-01T00:00:00.000Z',
};

const DORMANT = {
  ...ROW,
  state: 'dormant',
  consecutiveMissedPeriods: 3,
  dormantSince: '2026-01-08T05:00:00.000Z',
  dormancyReason: 'consecutive_miss',
};

describe('membershipResponseSchema', () => {
  it('accepts an active membership', () => {
    expect(membershipResponseSchema.parse(ROW)).toEqual(ROW);
  });

  it('accepts a dormant membership with its reason', () => {
    expect(membershipResponseSchema.parse(DORMANT)).toEqual(DORMANT);
  });

  it.each(['active', 'at_risk', 'dormant', 'removed'])('knows the %s state', (state) => {
    const row = state === 'dormant' ? DORMANT : { ...ROW, state };
    expect(membershipResponseSchema.safeParse(row).success).toBe(true);
  });

  it.each(['consecutive_miss', 'backstop', 'voluntary'])('knows the %s reason', (reason) => {
    expect(membershipResponseSchema.safeParse({ ...DORMANT, dormancyReason: reason }).success).toBe(
      true
    );
  });

  it.each([
    ['state', 'left'],
    ['dormancyReason', 'bored'],
    ['consecutiveMissedPeriods', -1],
    ['lastQualifyingDate', '2026-01-05T00:00:00Z'],
    ['joinedAt', 'yesterday'],
  ])('rejects a %s of %p', (key, value) => {
    const base = key === 'dormancyReason' ? DORMANT : ROW;
    expect(membershipResponseSchema.safeParse({ ...base, [key]: value }).success).toBe(false);
  });

  // memberships_dormancy_iff_dormant
  it('rejects a dormant membership without dormantSince and a reason', () => {
    expect(membershipResponseSchema.safeParse({ ...ROW, state: 'dormant' }).success).toBe(false);
  });

  it('rejects dormancy fields on a non-dormant membership', () => {
    const row = { ...DORMANT, state: 'active' };
    expect(membershipResponseSchema.safeParse(row).success).toBe(false);
  });

  it.each(['id', 'towerId', 'userId', 'habitId', 'state', 'joinedAt'])('requires %s', (key) => {
    const partial: Record<string, unknown> = { ...ROW };
    delete partial[key];
    expect(membershipResponseSchema.safeParse(partial).success).toBe(false);
  });

  it('infers the shared enums', () => {
    expectTypeOf<MembershipResponse>().not.toBeAny();
    expectTypeOf<MembershipResponse['state']>().toEqualTypeOf<
      'active' | 'at_risk' | 'dormant' | 'removed'
    >();
    expectTypeOf<MembershipResponse['dormancyReason']>().toEqualTypeOf<
      'consecutive_miss' | 'backstop' | 'voluntary' | null
    >();
  });
});
