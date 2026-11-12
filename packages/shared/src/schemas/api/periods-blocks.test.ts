import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  baseBlockResponseSchema,
  towerPeriodResponseSchema,
  type BaseBlockResponse,
  type BlockRoster,
  type TowerPeriodResponse,
} from '../index.js';

// Mirrors TowerPeriod (towers/periods/schema.ts) and BaseBlock
// (towers/blocks/schema.ts). Read-only resources: there are no request bodies.

const TOWER_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

const PENDING = {
  id: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e',
  towerId: TOWER_ID,
  periodStart: '2026-01-05',
  periodEnd: '2026-01-05',
  deadlineAt: '2026-01-06T05:00:00.000Z',
  evaluateAt: '2026-01-06T07:00:00.000Z',
  state: 'pending',
  outcome: null,
  evaluatedAt: null,
  claimedAt: null,
  attempts: 0,
  freebieSource: null,
  freebieGrantedBy: null,
  createdAt: '2026-01-05T00:00:00.000Z',
};

const EVALUATED = {
  ...PENDING,
  state: 'evaluated',
  outcome: 'survived',
  claimedAt: '2026-01-06T07:00:01.000Z',
  evaluatedAt: '2026-01-06T07:00:02.000Z',
  attempts: 1,
};

describe('towerPeriodResponseSchema', () => {
  it('accepts a pending period', () => {
    expect(towerPeriodResponseSchema.parse(PENDING)).toEqual(PENDING);
  });

  it('accepts an evaluated period', () => {
    expect(towerPeriodResponseSchema.parse(EVALUATED)).toEqual(EVALUATED);
  });

  it.each(['survived', 'collapsed', 'hibernated'])('knows the %s outcome', (outcome) => {
    expect(towerPeriodResponseSchema.safeParse({ ...EVALUATED, outcome }).success).toBe(true);
  });

  // tower_periods_freebie_fields_iff_freebie
  it('accepts a freebie with its source', () => {
    const row = { ...EVALUATED, outcome: 'freebie', freebieSource: 'earned' };
    expect(towerPeriodResponseSchema.safeParse(row).success).toBe(true);
  });

  it('rejects a freebie without a source', () => {
    const row = { ...EVALUATED, outcome: 'freebie' };
    expect(towerPeriodResponseSchema.safeParse(row).success).toBe(false);
  });

  it('rejects a freebie source on a non-freebie outcome', () => {
    const row = { ...EVALUATED, freebieSource: 'system' };
    expect(towerPeriodResponseSchema.safeParse(row).success).toBe(false);
  });

  // tower_periods_outcome_iff_evaluated
  it('rejects an outcome on a pending period', () => {
    expect(towerPeriodResponseSchema.safeParse({ ...PENDING, outcome: 'survived' }).success).toBe(
      false
    );
  });

  it('rejects an evaluated period without an outcome', () => {
    expect(towerPeriodResponseSchema.safeParse({ ...EVALUATED, outcome: null }).success).toBe(
      false
    );
  });

  it.each([
    ['state', 'done'],
    ['outcome', 'won'],
    ['periodStart', '2026/01/05'],
    ['attempts', -1],
    ['deadlineAt', '2026-01-06'],
  ])('rejects a %s of %p', (key, value) => {
    const base = key === 'outcome' ? EVALUATED : PENDING;
    expect(towerPeriodResponseSchema.safeParse({ ...base, [key]: value }).success).toBe(false);
  });

  it('infers the shared enums', () => {
    expectTypeOf<TowerPeriodResponse>().not.toBeAny();
    expectTypeOf<TowerPeriodResponse['state']>().toEqualTypeOf<
      'pending' | 'evaluating' | 'evaluated'
    >();
    expectTypeOf<TowerPeriodResponse['outcome']>().toEqualTypeOf<
      'survived' | 'collapsed' | 'hibernated' | 'freebie' | null
    >();
    expectTypeOf<TowerPeriodResponse['freebieSource']>().toEqualTypeOf<
      'earned' | 'host_granted' | 'system' | null
    >();
  });
});

describe('baseBlockResponseSchema', () => {
  const ROW = {
    id: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
    towerId: TOWER_ID,
    ordinal: 1,
    runStartDate: '2026-01-01',
    runEndDate: '2026-01-30',
    blockHeight: 30,
    roster: [
      {
        user_id: '3f1c6d32-6a4e-4a9e-bb1f-8f0f5a4f2c11',
        display_name: 'Sam',
        qualifying_days: 27,
        total_days: 30,
        highest_tier: 3,
        was_dormant: false,
      },
    ],
    createdAt: '2026-01-31T07:00:00.000Z',
  };

  it('accepts a serialized block row', () => {
    expect(baseBlockResponseSchema.parse(ROW)).toEqual(ROW);
  });

  // The roster reuses blockRosterSchema, so its strictness carries over (§5).
  it('rejects an empty roster', () => {
    expect(baseBlockResponseSchema.safeParse({ ...ROW, roster: [] }).success).toBe(false);
  });

  it('rejects a caused_collapse key inside the roster', () => {
    const roster = [{ ...ROW.roster[0], caused_collapse: true }];
    expect(baseBlockResponseSchema.safeParse({ ...ROW, roster }).success).toBe(false);
  });

  it.each([
    ['ordinal', 0],
    ['blockHeight', 0],
    ['runStartDate', 'Jan 1'],
  ])('rejects a %s of %p', (key, value) => {
    expect(baseBlockResponseSchema.safeParse({ ...ROW, [key]: value }).success).toBe(false);
  });

  it('types the roster as BlockRoster', () => {
    expectTypeOf<BaseBlockResponse>().not.toBeAny();
    expectTypeOf<BaseBlockResponse['roster']>().toEqualTypeOf<BlockRoster>();
  });
});
