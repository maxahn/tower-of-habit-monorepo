import { describe, expect, it } from 'vitest';
import { evaluationResponseSchema } from '../index.js';

/*
 * 2.19: POST /internal/towers/:towerId/periods/:periodId/evaluate. The
 * persisted outcome. No field identifies who caused a collapse (§5).
 */

const PERIOD = {
  id: '4b2e4c1a-0d6f-4f7e-8a3b-2c5d6e7f8a90',
  towerId: '1b2e4c1a-0d6f-4f7e-8a3b-2c5d6e7f8a90',
  periodStart: '2026-11-16',
  periodEnd: '2026-11-16',
  deadlineAt: '2026-11-17T05:00:00.000Z',
  evaluateAt: '2026-11-17T07:00:00.000Z',
  state: 'evaluated',
  outcome: 'collapsed',
  evaluatedAt: '2026-11-17T07:00:00.000Z',
  claimedAt: '2026-11-17T07:00:00.000Z',
  attempts: 1,
  freebieSource: null,
  freebieGrantedBy: null,
  createdAt: '2026-11-16T19:00:00.000Z',
};

const BODY = {
  period: PERIOD,
  outcome: 'collapsed',
  perMember: [
    { membershipId: '2b2e4c1a-0d6f-4f7e-8a3b-2c5d6e7f8a90', standing: 'met', consecutiveMisses: 0 },
    {
      membershipId: '2b2e4c1a-0d6f-4f7e-8a3b-2c5d6e7f8a91',
      standing: 'short',
      consecutiveMisses: 1,
    },
  ],
  transitions: [
    {
      membershipId: '2b2e4c1a-0d6f-4f7e-8a3b-2c5d6e7f8a91',
      type: 'at_risk',
      from: 'active',
      to: 'at_risk',
      reason: 'missed_period',
      effectiveFrom: '2026-11-17',
    },
  ],
  baseBlock: {
    id: '5b2e4c1a-0d6f-4f7e-8a3b-2c5d6e7f8a90',
    towerId: PERIOD.towerId,
    ordinal: 1,
    runStartDate: '2026-11-13',
    runEndDate: '2026-11-15',
    blockHeight: 3,
    roster: [
      {
        user_id: '3f1c6d32-6a4e-4a9e-bb1f-8f0f5a4f2c11',
        display_name: 'Max',
        qualifying_days: 3,
        total_days: 3,
        highest_tier: 0,
        was_dormant: false,
        periods_present: 3,
      },
    ],
    createdAt: '2026-11-17T07:00:00.000Z',
  },
  nextPeriod: {
    ...PERIOD,
    id: '6b2e4c1a-0d6f-4f7e-8a3b-2c5d6e7f8a90',
    periodStart: '2026-11-17',
    periodEnd: '2026-11-17',
    state: 'pending',
    outcome: null,
    evaluatedAt: null,
    claimedAt: null,
    attempts: 0,
  },
  tower: { height: 0, currentStreak: 0 },
};

describe('evaluationResponseSchema', () => {
  it('accepts a collapse with a base block and a next period', () => {
    const r = evaluationResponseSchema.safeParse(BODY);
    expect(r.success, JSON.stringify(r.success ? null : r.error.issues)).toBe(true);
  });

  it('accepts a survival with no block', () => {
    const r = evaluationResponseSchema.safeParse({
      ...BODY,
      period: { ...PERIOD, outcome: 'survived' },
      outcome: 'survived',
      transitions: [],
      baseBlock: null,
      tower: { height: 1, currentStreak: 1 },
    });
    expect(r.success).toBe(true);
  });

  it('pins the outcome vocabulary to the period_outcome enum', () => {
    expect(evaluationResponseSchema.safeParse({ ...BODY, outcome: 'wobbling' }).success).toBe(
      false
    );
  });

  it('has no blame field, at the top level or on the block', () => {
    expect(evaluationResponseSchema.safeParse({ ...BODY, missedBy: [] }).success).toBe(false);
    expect(
      evaluationResponseSchema.safeParse({
        ...BODY,
        baseBlock: { ...BODY.baseBlock, causedBy: 'x' },
      }).success
    ).toBe(false);
  });
});
