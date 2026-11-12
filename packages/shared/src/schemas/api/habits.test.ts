import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createHabitRequestSchema,
  habitResponseSchema,
  ROSTER_DISPLAY_NAME_MAX,
  updateHabitRequestSchema,
  type CreateHabitRequest,
  type HabitResponse,
  type UpdateHabitRequest,
} from '../index.js';

// Mirrors NewHabit / HabitPatch / Habit in @tower-of-habit/db (habits/habits.ts).
// ownerId comes from the authenticated session, never from the body.

const BINARY = { name: 'Meditate', type: 'binary' } as const;
const NUMERIC = { name: 'Read', type: 'numeric', unit: 'pages', quota: 1 } as const;
const TIERED = {
  name: 'Run',
  type: 'tiered',
  unit: null,
  tiers: [
    { tierIndex: 0, label: 'Base', thresholdValue: 1 },
    { tierIndex: 1, label: 'Strong', thresholdValue: 5 },
  ],
} as const;

describe('createHabitRequestSchema', () => {
  it.each([
    ['binary', BINARY],
    ['numeric', NUMERIC],
    ['tiered', TIERED],
  ])('accepts a minimal %s habit', (_, body) => {
    expect(createHabitRequestSchema.safeParse(body).success).toBe(true);
  });

  it('accepts the optional period fields', () => {
    const r = createHabitRequestSchema.safeParse({
      ...BINARY,
      periodUnit: 'week',
      periodLength: 1,
      quota: 3,
    });
    expect(r.success).toBe(true);
  });

  // habits_unit_iff_numeric
  it('requires a unit for a numeric habit', () => {
    const { unit, ...rest } = NUMERIC;
    void unit;
    expect(createHabitRequestSchema.safeParse(rest).success).toBe(false);
  });

  it.each([
    ['binary', BINARY],
    ['tiered', TIERED],
  ])('rejects a unit on a %s habit', (_, body) => {
    expect(createHabitRequestSchema.safeParse({ ...body, unit: 'pages' }).success).toBe(false);
  });

  it('requires tiers on a tiered habit', () => {
    const { tiers, ...rest } = TIERED;
    void tiers;
    expect(createHabitRequestSchema.safeParse(rest).success).toBe(false);
  });

  it('requires tier 0 among a tiered habit’s tiers', () => {
    const body = { ...TIERED, tiers: [{ tierIndex: 1, label: 'Strong', thresholdValue: 5 }] };
    expect(createHabitRequestSchema.safeParse(body).success).toBe(false);
  });

  it('rejects duplicate tier indexes', () => {
    const body = {
      ...TIERED,
      tiers: [
        { tierIndex: 0, label: 'Base', thresholdValue: 1 },
        { tierIndex: 0, label: 'Again', thresholdValue: 2 },
      ],
    };
    expect(createHabitRequestSchema.safeParse(body).success).toBe(false);
  });

  it.each([
    ['binary', BINARY],
    ['numeric', NUMERIC],
  ])('rejects tiers on a %s habit', (_, body) => {
    expect(createHabitRequestSchema.safeParse({ ...body, tiers: TIERED.tiers }).success).toBe(
      false
    );
  });

  it('rejects an unknown habit type', () => {
    expect(createHabitRequestSchema.safeParse({ ...BINARY, type: 'boolean' }).success).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects a quota of %p', (quota) => {
    expect(createHabitRequestSchema.safeParse({ ...BINARY, quota }).success).toBe(false);
  });

  it.each([0, -1, 1.5])('rejects a periodLength of %p', (periodLength) => {
    expect(createHabitRequestSchema.safeParse({ ...BINARY, periodLength }).success).toBe(false);
  });

  it('rejects an unknown periodUnit', () => {
    expect(createHabitRequestSchema.safeParse({ ...BINARY, periodUnit: 'month' }).success).toBe(
      false
    );
  });

  it('accepts a name at the limit and rejects one past it', () => {
    const at = 'x'.repeat(ROSTER_DISPLAY_NAME_MAX);
    expect(createHabitRequestSchema.safeParse({ ...BINARY, name: at }).success).toBe(true);
    expect(createHabitRequestSchema.safeParse({ ...BINARY, name: `${at}x` }).success).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(createHabitRequestSchema.safeParse({ ...BINARY, name: '' }).success).toBe(false);
  });

  // Server-owned fields: identity from auth, lifecycle through transitions.
  it.each([
    ['ownerId', '3f1c6d32-6a4e-4a9e-bb1f-8f0f5a4f2c11'],
    ['id', '3f1c6d32-6a4e-4a9e-bb1f-8f0f5a4f2c11'],
    ['lifecycle', 'active'],
    ['startedAt', '2026-01-01T00:00:00.000Z'],
    ['createdAt', '2026-01-01T00:00:00.000Z'],
  ])('rejects a client-supplied %s', (key, value) => {
    expect(createHabitRequestSchema.safeParse({ ...BINARY, [key]: value }).success).toBe(false);
  });

  it('infers a discriminated union on type', () => {
    expectTypeOf<CreateHabitRequest>().not.toBeAny();
    expectTypeOf<CreateHabitRequest['type']>().toEqualTypeOf<'binary' | 'numeric' | 'tiered'>();
  });
});

describe('updateHabitRequestSchema', () => {
  it('accepts an empty patch', () => {
    expect(updateHabitRequestSchema.safeParse({}).success).toBe(true);
  });

  it.each([{ name: 'Renamed' }, { quota: 2 }, { periodUnit: 'week' }, { unit: 'minutes' }])(
    'accepts the partial patch %o',
    (patch) => {
      expect(updateHabitRequestSchema.safeParse(patch).success).toBe(true);
    }
  );

  // Type is immutable (it would break the tier invariant); lifecycle changes
  // only through transitions; ownership never changes.
  it.each([
    ['type', 'numeric'],
    ['ownerId', '3f1c6d32-6a4e-4a9e-bb1f-8f0f5a4f2c11'],
    ['lifecycle', 'archived'],
    ['tiers', []],
  ])('rejects %s', (key, value) => {
    expect(updateHabitRequestSchema.safeParse({ [key]: value }).success).toBe(false);
  });

  it.each([{ quota: 0 }, { name: '' }, { periodLength: -1 }])(
    'rejects the invalid patch %o',
    (p) => {
      expect(updateHabitRequestSchema.safeParse(p).success).toBe(false);
    }
  );

  it('infers an all-optional type', () => {
    expectTypeOf<UpdateHabitRequest>().not.toBeAny();
    expectTypeOf({}).toExtend<UpdateHabitRequest>();
  });
});

describe('habitResponseSchema', () => {
  // A Habit row as it arrives over JSON: Dates are ISO strings.
  const ROW = {
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

  it('accepts a serialized habit row', () => {
    expect(habitResponseSchema.parse(ROW)).toEqual(ROW);
  });

  it('accepts a draft with null timestamps', () => {
    const draft = { ...ROW, lifecycle: 'draft', startedAt: null };
    expect(habitResponseSchema.safeParse(draft).success).toBe(true);
  });

  it('rejects a Date object where JSON would carry a string', () => {
    expect(
      habitResponseSchema.safeParse({ ...ROW, createdAt: new Date('2026-01-01T12:00:00.000Z') })
        .success
    ).toBe(false);
  });

  it.each([
    ['id', 'not-a-uuid'],
    ['lifecycle', 'deleted'],
    ['createdAt', '2026-01-01'],
    ['type', 'boolean'],
  ])('rejects a %s of %p', (key, value) => {
    expect(habitResponseSchema.safeParse({ ...ROW, [key]: value }).success).toBe(false);
  });

  it.each(['id', 'ownerId', 'name', 'type', 'lifecycle', 'createdAt'])('requires %s', (key) => {
    const partial: Record<string, unknown> = { ...ROW };
    delete partial[key];
    expect(habitResponseSchema.safeParse(partial).success).toBe(false);
  });

  it('infers string timestamps and the shared enums', () => {
    expectTypeOf<HabitResponse>().not.toBeAny();
    expectTypeOf<HabitResponse['createdAt']>().toEqualTypeOf<string>();
    expectTypeOf<HabitResponse['startedAt']>().toEqualTypeOf<string | null>();
    expectTypeOf<HabitResponse['lifecycle']>().toEqualTypeOf<
      'draft' | 'active' | 'paused' | 'archived'
    >();
  });
});
