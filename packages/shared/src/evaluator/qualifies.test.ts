import { afterEach, describe, expect, it, vi } from 'vitest';
import * as evaluator from './index.js';
import {
  HabitConfigError,
  qualifies,
  type EntryDraft,
  type HabitConfig,
  type QualifyingTier,
} from './qualifies.js';

const binary = (tiers: readonly QualifyingTier[] = []): HabitConfig => ({ type: 'binary', tiers });

const numeric = (threshold: number | null, extra: readonly QualifyingTier[] = []): HabitConfig => ({
  type: 'numeric',
  tiers: [{ tierIndex: 0, thresholdValue: threshold }, ...extra],
});

const tiered = (
  tiers: readonly QualifyingTier[] = [
    { tierIndex: 0, thresholdValue: null },
    { tierIndex: 1, thresholdValue: null },
  ]
): HabitConfig => ({ type: 'tiered', tiers });

function configErrorOf(habit: HabitConfig, entry: EntryDraft): HabitConfigError {
  try {
    qualifies(habit, entry);
  } catch (e) {
    expect(e).toBeInstanceOf(HabitConfigError);
    return e as HabitConfigError;
  }
  throw new Error('expected qualifies to throw HabitConfigError');
}

describe('binary: any entry qualifies', () => {
  it.each<[string, EntryDraft]>([
    ['empty entry', {}],
    ['numericValue 0', { numericValue: 0 }],
    ['negative numericValue', { numericValue: -5 }],
    ['tierReached 0', { tierReached: 0 }],
    ['tierReached null', { tierReached: null }],
    ['tierReached -1', { tierReached: -1 }],
  ])('%s → true', (_label, entry) => {
    expect(qualifies(binary(), entry)).toBe(true);
  });

  it('ignores tiers entirely: no base tier is not an error', () => {
    expect(() => qualifies(binary([]), {})).not.toThrow();
    expect(qualifies(binary([{ tierIndex: 1, thresholdValue: 99 }]), {})).toBe(true);
  });
});

describe('numeric: qualifies when numericValue >= base thresholdValue', () => {
  it.each<[number, number, boolean]>([
    [10, 9.99, false],
    [10, 10, true], // inclusive boundary
    [10, 10.01, true],
    [10, 1e9, true],
    [0, 0, true],
    [0, -1, false],
    [-5, -5, true],
    [-5, -6, false],
    [2.5, 2.5, true],
    [2.5, 2.4999, false],
  ])('threshold %d, value %d → %s', (threshold, value, expected) => {
    expect(qualifies(numeric(threshold), { numericValue: value })).toBe(expected);
  });

  it.each<[string, EntryDraft]>([
    ['missing', {}],
    ['null', { numericValue: null }],
  ])('numericValue %s → false, not an error', (_label, entry) => {
    expect(qualifies(numeric(10), entry)).toBe(false);
  });

  it('finds the base tier by tierIndex, not array position', () => {
    const habit: HabitConfig = {
      type: 'numeric',
      tiers: [
        { tierIndex: 1, thresholdValue: 50 },
        { tierIndex: 0, thresholdValue: 10 },
      ],
    };
    expect(qualifies(habit, { numericValue: 20 })).toBe(true);
    expect(qualifies(habit, { numericValue: 9 })).toBe(false);
  });

  it('ignores higher tiers: base tier alone decides', () => {
    const habit = numeric(10, [{ tierIndex: 1, thresholdValue: 50 }]);
    expect(qualifies(habit, { numericValue: 20 })).toBe(true);
  });

  it('ignores tierReached', () => {
    expect(qualifies(numeric(10), { numericValue: 5, tierReached: 3 })).toBe(false);
    expect(qualifies(numeric(10), { tierReached: 0 })).toBe(false);
  });
});

describe('numeric: missing base threshold is a typed config error', () => {
  it.each<[string, HabitConfig]>([
    ['no tiers', { type: 'numeric', tiers: [] }],
    ['only non-base tiers', { type: 'numeric', tiers: [{ tierIndex: 1, thresholdValue: 5 }] }],
    ['base tier with null threshold', numeric(null)],
  ])('%s → throws HabitConfigError', (_label, habit) => {
    expect(() => qualifies(habit, { numericValue: 1 })).toThrow(HabitConfigError);
    const err = configErrorOf(habit, { numericValue: 1 });
    expect(err.reason).toBe('missing_base_threshold');
    expect(err.habitType).toBe('numeric');
    expect(err.name).toBe('HabitConfigError');
  });

  it('throws regardless of entry value, never defaulting to true', () => {
    const habit: HabitConfig = { type: 'numeric', tiers: [] };
    for (const entry of [{ numericValue: 1e9 }, { numericValue: 0 }, {}] as EntryDraft[]) {
      expect(() => qualifies(habit, entry)).toThrow(HabitConfigError);
    }
  });
});

describe('tiered: qualifies when tierReached >= 0', () => {
  it.each<[string, EntryDraft, boolean]>([
    ['tierReached 0', { tierReached: 0 }, true],
    ['tierReached 3', { tierReached: 3 }, true],
    ['tierReached -1', { tierReached: -1 }, false],
    ['tierReached missing', {}, false],
    ['tierReached null', { tierReached: null }, false],
  ])('%s → %s', (_label, entry, expected) => {
    expect(qualifies(tiered(), entry)).toBe(expected);
  });

  it('does not consult thresholds (null base threshold is fine)', () => {
    expect(() => qualifies(tiered(), { tierReached: 0 })).not.toThrow();
    expect(qualifies(tiered([{ tierIndex: 0, thresholdValue: 100 }]), { tierReached: 0 })).toBe(
      true
    );
  });

  it('ignores numericValue', () => {
    expect(qualifies(tiered(), { numericValue: 999 })).toBe(false);
  });
});

describe('determinism: same input, same result', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const table: [HabitConfig, EntryDraft, boolean][] = [
    [binary(), {}, true],
    [numeric(10), { numericValue: 10 }, true],
    [numeric(10), { numericValue: 9 }, false],
    [numeric(10), {}, false],
    [tiered(), { tierReached: 0 }, true],
    [tiered(), { tierReached: -1 }, false],
    [tiered(), {}, false],
  ];

  const runAll = (rows: typeof table) => rows.map(([h, e]) => qualifies(h, e));
  const expected = table.map(([, , x]) => x);

  it('is independent of call order', () => {
    expect(runAll(table)).toEqual(expected);
    expect(runAll([...table].reverse())).toEqual([...expected].reverse());
    const interleaved = table.flatMap((row, i) => [row, table[table.length - 1 - i]!]);
    expect(runAll(interleaved)).toEqual(interleaved.map(([, , x]) => x));
  });

  it('has no "already logged" memory: repeat calls agree', () => {
    const habit = numeric(10);
    const entry = { numericValue: 12 };
    expect([1, 2, 3].map(() => qualifies(habit, entry))).toEqual([true, true, true]);
  });

  it('does not depend on the clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-08T08:30:00Z'));
    const first = runAll(table);
    vi.setSystemTime(new Date('2031-12-31T23:59:59Z'));
    expect(runAll(table)).toEqual(first);
    expect(first).toEqual(expected);
  });

  it('does not mutate its inputs', () => {
    const freeze = (h: HabitConfig): HabitConfig =>
      Object.freeze({ ...h, tiers: Object.freeze(h.tiers.map((t) => Object.freeze({ ...t }))) });
    for (const [h, e, x] of table) {
      const habit = freeze(h);
      const entry = Object.freeze({ ...e });
      const before = structuredClone({ habit, entry });
      expect(qualifies(habit, entry)).toBe(x);
      expect({ habit, entry }).toEqual(before);
    }
  });
});

describe('evaluator barrel', () => {
  it.each(['qualifies', 'HabitConfigError'])('exports %s', (name) => {
    expect((evaluator as Record<string, unknown>)[name]).toBeDefined();
  });
});
