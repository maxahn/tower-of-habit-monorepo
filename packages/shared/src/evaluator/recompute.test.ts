import { describe, expect, it } from 'vitest';
import { addDays } from '../time/local-date.js';
import {
  allMembersDormant,
  memberMissedPeriods,
  membersLoggedToday,
  towerRunningFor,
  towerWithBaseBlocks,
  type ScenarioPlan,
} from '../testing/index.js';
import {
  diffTowerState,
  MIN_BLOCK_DAYS,
  recomputeTowerState,
  verifyTowerState,
  type RecomputePeriod,
  type RecomputePeriodOutcome,
  type StoredTowerState,
} from './recompute.js';

const DAY1 = '2026-10-01';

/** A daily ledger from a compact spec: 'S' survived, 'C' collapsed, 'H' hibernated, 'F' freebie, '.' pending. */
function ledger(spec: string): RecomputePeriod[] {
  const codes: Record<string, RecomputePeriodOutcome> = {
    S: 'survived',
    C: 'collapsed',
    H: 'hibernated',
    F: 'freebie',
  };
  return [...spec].map((c, i) => {
    const date = addDays(DAY1, i);
    const outcome = codes[c] ?? null;
    return {
      periodStart: date,
      periodEnd: date,
      state: outcome ? 'evaluated' : 'pending',
      outcome,
    };
  });
}

const day = (n: number) => addDays(DAY1, n - 1);

describe('recomputeTowerState', () => {
  it('an empty ledger is a tower at 0', () => {
    expect(recomputeTowerState([])).toEqual({
      height: 0,
      currentStreak: 0,
      blocks: [],
      issues: [],
    });
  });

  it('ignores pending periods', () => {
    expect(recomputeTowerState(ledger('...'))).toMatchObject({ height: 0, blocks: [] });
  });

  it('counts survived periods', () => {
    expect(recomputeTowerState(ledger('SSSSS.'))).toMatchObject({
      height: 5,
      currentStreak: 5,
      blocks: [],
      issues: [],
    });
  });

  it(`a run shorter than MIN_BLOCK_DAYS (${MIN_BLOCK_DAYS}) leaves no block`, () => {
    expect(recomputeTowerState(ledger('SSCS'))).toMatchObject({ height: 1, blocks: [] });
  });

  it('a collapse closes a long enough run into a block, then resets', () => {
    expect(recomputeTowerState(ledger('SSSCSS'))).toMatchObject({
      height: 2,
      blocks: [{ runStartDate: day(1), runEndDate: day(3), blockHeight: 3 }],
    });
  });

  it('hibernation pauses the run without extending or closing it', () => {
    const r = recomputeTowerState(ledger('SSHHSC'));
    expect(r.blocks).toEqual([{ runStartDate: day(1), runEndDate: day(5), blockHeight: 3 }]);
    expect(r.height).toBe(0);
  });

  it('a trailing hibernation does not move run_end', () => {
    expect(recomputeTowerState(ledger('SSSSHHC')).blocks).toEqual([
      { runStartDate: day(1), runEndDate: day(4), blockHeight: 4 },
    ]);
  });

  it('freebies neither move height nor close the run', () => {
    expect(recomputeTowerState(ledger('SSFSC')).blocks).toEqual([
      { runStartDate: day(1), runEndDate: day(4), blockHeight: 3 },
    ]);
  });

  it('back-to-back collapses leave no empty blocks', () => {
    expect(recomputeTowerState(ledger('SSSCCCSSSSC')).blocks).toEqual([
      { runStartDate: day(1), runEndDate: day(3), blockHeight: 3 },
      { runStartDate: day(7), runEndDate: day(10), blockHeight: 4 },
    ]);
  });

  it('sorts by period_start and does not mutate its input', () => {
    const periods = ledger('SSSCS');
    const shuffled = [periods[4]!, periods[1]!, periods[3]!, periods[0]!, periods[2]!];
    const copy = structuredClone(shuffled);
    expect(recomputeTowerState(shuffled)).toEqual(recomputeTowerState(periods));
    expect(shuffled).toEqual(copy);
  });

  it('flags a period evaluated after an undecided one', () => {
    const r = recomputeTowerState(ledger('SS.S'));
    expect(r.height).toBe(3);
    expect(r.issues).toEqual([
      `period ${day(4)} is evaluated but the earlier period ${day(3)} is not`,
    ]);
  });

  it('flags an evaluated period with no outcome', () => {
    const periods = ledger('SS');
    periods[1]!.outcome = null;
    expect(recomputeTowerState(periods).issues).toEqual([
      `period ${day(2)} is evaluated but has no outcome`,
    ]);
  });
});

describe('diffTowerState', () => {
  const recomputed = recomputeTowerState(ledger('SSSCSS'));
  const stored: StoredTowerState = {
    height: 2,
    currentStreak: 2,
    blocks: [{ runStartDate: day(1), runEndDate: day(3), blockHeight: 3 }],
  };

  it('is empty when stored agrees', () => {
    expect(diffTowerState(recomputed, stored)).toEqual([]);
  });

  it('reports every differing field', () => {
    expect(
      diffTowerState(recomputed, {
        height: 5,
        currentStreak: 2,
        blocks: [
          { runStartDate: day(1), runEndDate: day(4), blockHeight: 3 },
          { runStartDate: day(5), runEndDate: day(6), blockHeight: 2 },
        ],
      })
    ).toEqual([
      { field: 'height', expected: 2, actual: 5 },
      { field: 'blocks.length', expected: 1, actual: 2 },
      { field: 'blocks[0].runEndDate', expected: day(3), actual: day(4) },
      { field: 'blocks[1].runStartDate', expected: null, actual: day(5) },
      { field: 'blocks[1].runEndDate', expected: null, actual: day(6) },
      { field: 'blocks[1].blockHeight', expected: null, actual: 2 },
    ]);
  });
});

// The 1.12 done-when: recompute reproduces the stored values of every 1.11
// scenario, and corrupting a stored value makes it fail. deriveTowerState
// produced those values independently, so agreement here is not by construction.
const NOW = new Date('2026-10-27T18:00:00Z');

function stored(plan: ScenarioPlan): StoredTowerState {
  return {
    height: plan.tower!.height,
    currentStreak: plan.tower!.currentStreak,
    blocks: plan.blocks,
  };
}

const scenarios: [string, () => ScenarioPlan][] = [
  ['day 1, nothing evaluated', () => towerRunningFor(1, { now: NOW })],
  ['30 healthy days', () => towerRunningFor(30, { now: NOW, members: 2 })],
  [
    'the 1.11 done-when: 3 members, day 12, one missed',
    () => towerRunningFor(12, { now: NOW, members: 3, traits: [memberMissedPeriods(1)] }),
  ],
  [
    'two misses: dormant instead of a second collapse',
    () => towerRunningFor(8, { now: NOW, members: 2, traits: [memberMissedPeriods(2)] }),
  ],
  [
    'all dormant: collapse, then hibernation',
    () => towerRunningFor(10, { now: NOW, members: 2, traits: [allMembersDormant()] }),
  ],
  [
    'hibernation running for several days',
    () =>
      towerRunningFor(10, {
        now: NOW,
        members: 2,
        traits: [memberMissedPeriods(4, { member: 0 }), memberMissedPeriods(4, { member: 1 })],
      }),
  ],
  ...[1, 2, 3].map((n): [string, () => ScenarioPlan] => [
    `${n} base block(s)`,
    () => towerWithBaseBlocks(n, { now: NOW, members: 2 }),
  ]),
  [
    'members logged today',
    () => towerRunningFor(6, { now: NOW, members: 3, traits: [membersLoggedToday(2)] }),
  ],
  [
    'yesterday pending inside its grace window',
    () => towerRunningFor(5, { now: new Date('2026-10-28T06:30:00Z'), deadline: '23:00' }),
  ],
  ['across the DST fall-back', () => towerRunningFor(5, { now: new Date('2026-11-03T19:00:00Z') })],
];

describe('verifyTowerState against 1.11 scenarios', () => {
  it.each(scenarios)('reproduces stored state: %s', (_, build) => {
    const plan = build();
    const v = verifyTowerState(plan.periods, stored(plan));
    expect(v.divergences).toEqual([]);
    expect(v.recomputed.issues).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('fails when stored height is corrupted', () => {
    const plan = towerRunningFor(12, { now: NOW, members: 3 });
    plan.tower!.height += 1;
    const v = verifyTowerState(plan.periods, stored(plan));
    expect(v.ok).toBe(false);
    expect(v.divergences).toEqual([{ field: 'height', expected: 11, actual: 12 }]);
  });

  it('fails when stored current_streak is corrupted', () => {
    const plan = towerRunningFor(12, { now: NOW });
    plan.tower!.currentStreak = 0;
    expect(verifyTowerState(plan.periods, stored(plan)).divergences).toEqual([
      { field: 'currentStreak', expected: 11, actual: 0 },
    ]);
  });

  it("fails when a block's boundary is shifted", () => {
    const plan = towerWithBaseBlocks(2, { now: NOW, members: 2 });
    const original = plan.blocks[1]!.runEndDate;
    plan.blocks[1]!.runEndDate = addDays(original, 1);
    expect(verifyTowerState(plan.periods, stored(plan)).divergences).toEqual([
      { field: 'blocks[1].runEndDate', expected: original, actual: addDays(original, 1) },
    ]);
  });

  it('fails when a block is missing', () => {
    const plan = towerWithBaseBlocks(2, { now: NOW, members: 2 });
    plan.blocks.pop();
    const v = verifyTowerState(plan.periods, stored(plan));
    expect(v.ok).toBe(false);
    expect(v.divergences[0]).toEqual({ field: 'blocks.length', expected: 2, actual: 1 });
  });
});
