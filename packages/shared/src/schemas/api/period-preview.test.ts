import { describe, expect, it } from 'vitest';
import { periodPreviewResponseSchema } from '../index.js';

/*
 * 2.17: GET /towers/:id/period — the live state of the current period, from
 * the same evaluatePeriod call the evaluation job makes.
 */

const PERIOD = {
  id: '4b2e4c1a-0d6f-4f7e-8a3b-2c5d6e7f8a90',
  towerId: '1b2e4c1a-0d6f-4f7e-8a3b-2c5d6e7f8a90',
  periodStart: '2026-11-16',
  periodEnd: '2026-11-16',
  deadlineAt: '2026-11-17T05:00:00.000Z',
  evaluateAt: '2026-11-17T07:00:00.000Z',
  state: 'pending',
  outcome: null,
  evaluatedAt: null,
  claimedAt: null,
  attempts: 0,
  freebieSource: null,
  freebieGrantedBy: null,
  createdAt: '2026-11-16T19:00:00.000Z',
};

const BODY = {
  period: PERIOD,
  window: {
    periodStart: '2026-11-16',
    periodEnd: '2026-11-16',
    nudgeAt: '2026-11-17T01:00:00.000Z',
    wobbleAt: '2026-11-17T03:00:00.000Z',
    deadlineAt: '2026-11-17T05:00:00.000Z',
    evaluateAt: '2026-11-17T07:00:00.000Z',
  },
  now: '2026-11-16T19:00:00.000Z',
  periodStatus: 'wobbling',
  quota: 1,
  members: [
    {
      membershipId: '2b2e4c1a-0d6f-4f7e-8a3b-2c5d6e7f8a90',
      userId: '3f1c6d32-6a4e-4a9e-bb1f-8f0f5a4f2c11',
      displayName: 'Max',
      state: 'active',
      qualifyingDays: 0,
      standing: 'short',
      daysNeeded: 1,
      daysRemaining: 1,
      slack: 0,
    },
  ],
  outstanding: ['2b2e4c1a-0d6f-4f7e-8a3b-2c5d6e7f8a90'],
  height: 3,
  currentStreak: 3,
  soloActive: false,
};

describe('periodPreviewResponseSchema', () => {
  it('accepts the preview', () => {
    expect(periodPreviewResponseSchema.safeParse(BODY).success).toBe(true);
  });

  it('pins the status vocabulary to the evaluator’s', () => {
    for (const periodStatus of ['open', 'wobbling', 'survived', 'collapsed']) {
      expect(periodPreviewResponseSchema.safeParse({ ...BODY, periodStatus }).success).toBe(true);
    }
    expect(
      periodPreviewResponseSchema.safeParse({ ...BODY, periodStatus: 'pending' }).success
    ).toBe(false);
  });

  it('never carries transitions or a base block: the preview persists nothing', () => {
    expect(periodPreviewResponseSchema.safeParse({ ...BODY, transitions: [] }).success).toBe(false);
  });
});
