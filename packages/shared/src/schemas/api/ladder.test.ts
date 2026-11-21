import { describe, expect, it } from 'vitest';
import {
  habitDetailResponseSchema,
  habitListResponseSchema,
  replaceTiersRequestSchema,
  tierLadderIssues,
} from '../index.js';

/*
 * 2.12: the tier ladder is one consistent object, validated as a whole.
 *   - levels contiguous from 0;
 *   - numeric: every threshold set and strictly increasing;
 *   - binary: no ladder at all.
 * tierLadderIssues is the one rule, used by the create schema and by
 * PUT /habits/:id/tiers (whose handler knows the habit type, the body doesn't).
 */

const t = (tierIndex: number, thresholdValue: number | null = null) => ({
  tierIndex,
  label: `T${tierIndex}`,
  thresholdValue,
});

describe('tierLadderIssues', () => {
  it('accepts a contiguous tiered ladder with any thresholds', () => {
    expect(tierLadderIssues('tiered', [t(0), t(1, 5), t(2)])).toEqual([]);
  });

  it('accepts a numeric ladder with strictly increasing thresholds', () => {
    expect(tierLadderIssues('numeric', [t(0, 10), t(1, 20), t(2, 30.5)])).toEqual([]);
  });

  it('accepts a ladder given out of order', () => {
    expect(tierLadderIssues('numeric', [t(1, 20), t(0, 10)])).toEqual([]);
  });

  it('rejects an empty ladder on numeric and tiered habits', () => {
    expect(tierLadderIssues('numeric', [])).not.toEqual([]);
    expect(tierLadderIssues('tiered', [])).not.toEqual([]);
  });

  it('rejects any ladder on a binary habit', () => {
    expect(tierLadderIssues('binary', [t(0)])).not.toEqual([]);
    expect(tierLadderIssues('binary', [])).toEqual([]);
  });

  it('rejects a missing tier 0, a gap, and a duplicate', () => {
    expect(tierLadderIssues('tiered', [t(1)])).not.toEqual([]);
    expect(tierLadderIssues('tiered', [t(0), t(2)])).not.toEqual([]);
    expect(tierLadderIssues('tiered', [t(0), t(0)])).not.toEqual([]);
  });

  it('rejects a numeric ladder with a null or non-increasing threshold', () => {
    expect(tierLadderIssues('numeric', [t(0, null)])).not.toEqual([]);
    expect(tierLadderIssues('numeric', [t(0, 10), t(1, 10)])).not.toEqual([]);
    expect(tierLadderIssues('numeric', [t(0, 10), t(1, 5)])).not.toEqual([]);
  });

  it('names a path per issue so it can become validation details', () => {
    const issues = tierLadderIssues('numeric', [t(0, 10), t(1, 5)]);
    expect(issues[0]).toMatchObject({
      path: expect.stringMatching(/^tiers/),
      message: expect.any(String),
    });
  });
});

describe('replaceTiersRequestSchema', () => {
  it('accepts a non-empty ladder and nothing else', () => {
    expect(replaceTiersRequestSchema.safeParse({ tiers: [t(0)] }).success).toBe(true);
    expect(replaceTiersRequestSchema.safeParse({ tiers: [] }).success).toBe(false);
    expect(replaceTiersRequestSchema.safeParse({ tiers: [t(0)], habitId: 'x' }).success).toBe(
      false
    );
  });
});

describe('habitDetailResponseSchema / habitListResponseSchema', () => {
  const HABIT = {
    id: '9b2e4c1a-0d6f-4f7e-8a3b-2c5d6e7f8a90',
    ownerId: '3f1c6d32-6a4e-4a9e-bb1f-8f0f5a4f2c11',
    name: 'Read',
    type: 'numeric',
    unit: 'pages',
    periodUnit: 'day',
    periodLength: 1,
    quota: 1,
    lifecycle: 'active',
    startedAt: '2026-01-05T17:00:00.000Z',
    archivedAt: null,
    createdAt: '2026-01-01T12:00:00.000Z',
    updatedAt: '2026-01-05T17:00:00.000Z',
  };
  const TIER = { id: 'c0ffee00-0d6f-4f7e-8a3b-2c5d6e7f8a90', habitId: HABIT.id, ...t(0, 10) };

  it('carries the habit, its ladder, the current streak and the owning tower (or null)', () => {
    const detached = { habit: HABIT, tiers: [TIER], currentStreak: 3, tower: null };
    expect(habitDetailResponseSchema.safeParse(detached).success).toBe(true);
    const bound = {
      ...detached,
      tower: {
        id: '1b2e4c1a-0d6f-4f7e-8a3b-2c5d6e7f8a90',
        name: 'Morning run',
        lifecycle: 'active',
        membershipState: 'active',
      },
    };
    expect(habitDetailResponseSchema.safeParse(bound).success).toBe(true);
  });

  it('rejects a negative streak', () => {
    expect(
      habitDetailResponseSchema.safeParse({
        habit: HABIT,
        tiers: [],
        currentStreak: -1,
        tower: null,
      }).success
    ).toBe(false);
  });

  it('lists habits', () => {
    expect(habitListResponseSchema.safeParse({ habits: [HABIT] }).success).toBe(true);
  });
});
