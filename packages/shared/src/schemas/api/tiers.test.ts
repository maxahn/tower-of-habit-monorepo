import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createHabitTierRequestSchema,
  habitTierResponseSchema,
  ROSTER_DISPLAY_NAME_MAX,
  updateHabitTierRequestSchema,
  type CreateHabitTierRequest,
  type HabitTierResponse,
  type UpdateHabitTierRequest,
} from '../index.js';

// Mirrors NewHabitTier / HabitTierPatch / HabitTier (habits/tiers/tiers.ts).
// habitId comes from the route, never from the body.

const TIER = { tierIndex: 1, label: 'Strong', thresholdValue: 5 };

describe('createHabitTierRequestSchema', () => {
  it('accepts a tier', () => {
    expect(createHabitTierRequestSchema.parse(TIER)).toEqual(TIER);
  });

  it('accepts tier 0 and a null threshold', () => {
    const r = createHabitTierRequestSchema.safeParse({
      ...TIER,
      tierIndex: 0,
      thresholdValue: null,
    });
    expect(r.success).toBe(true);
  });

  it.each([-1, 1.5, Number.NaN])('rejects a tierIndex of %p', (tierIndex) => {
    expect(createHabitTierRequestSchema.safeParse({ ...TIER, tierIndex }).success).toBe(false);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, '5'])(
    'rejects a thresholdValue of %p',
    (thresholdValue) => {
      expect(createHabitTierRequestSchema.safeParse({ ...TIER, thresholdValue }).success).toBe(
        false
      );
    }
  );

  it('bounds the label', () => {
    const at = 'x'.repeat(ROSTER_DISPLAY_NAME_MAX);
    expect(createHabitTierRequestSchema.safeParse({ ...TIER, label: at }).success).toBe(true);
    expect(createHabitTierRequestSchema.safeParse({ ...TIER, label: `${at}x` }).success).toBe(
      false
    );
    expect(createHabitTierRequestSchema.safeParse({ ...TIER, label: '' }).success).toBe(false);
  });

  it('rejects a client-supplied habitId', () => {
    const body = { ...TIER, habitId: '9b2e4c1a-0d6f-4f7e-8a3b-2c5d6e7f8a90' };
    expect(createHabitTierRequestSchema.safeParse(body).success).toBe(false);
  });

  it('infers a non-any type', () => {
    expectTypeOf<CreateHabitTierRequest>().not.toBeAny();
    expectTypeOf<CreateHabitTierRequest['tierIndex']>().toEqualTypeOf<number>();
  });
});

describe('updateHabitTierRequestSchema', () => {
  it.each([{}, { label: 'Elite' }, { thresholdValue: null }])('accepts %o', (patch) => {
    expect(updateHabitTierRequestSchema.safeParse(patch).success).toBe(true);
  });

  it.each([{ tierIndex: -1 }, { label: '' }, { habitId: '9b2e4c1a-0d6f-4f7e-8a3b-2c5d6e7f8a90' }])(
    'rejects %o',
    (patch) => {
      expect(updateHabitTierRequestSchema.safeParse(patch).success).toBe(false);
    }
  );

  it('infers an all-optional type', () => {
    expectTypeOf<UpdateHabitTierRequest>().not.toBeAny();
    expectTypeOf({}).toExtend<UpdateHabitTierRequest>();
  });
});

describe('habitTierResponseSchema', () => {
  const ROW = {
    id: 'c0ffee00-0d6f-4f7e-8a3b-2c5d6e7f8a90',
    habitId: '9b2e4c1a-0d6f-4f7e-8a3b-2c5d6e7f8a90',
    ...TIER,
  };

  it('accepts a serialized tier row', () => {
    expect(habitTierResponseSchema.parse(ROW)).toEqual(ROW);
  });

  it.each(['id', 'habitId', 'tierIndex', 'label'])('requires %s', (key) => {
    const partial: Record<string, unknown> = { ...ROW };
    delete partial[key];
    expect(habitTierResponseSchema.safeParse(partial).success).toBe(false);
  });

  it('infers a non-any type', () => {
    expectTypeOf<HabitTierResponse>().not.toBeAny();
    expectTypeOf<HabitTierResponse['thresholdValue']>().toEqualTypeOf<number | null>();
  });
});
