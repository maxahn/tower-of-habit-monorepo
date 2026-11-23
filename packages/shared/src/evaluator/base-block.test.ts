import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NUDGE_LEAD_MINUTES,
  DEFAULT_WOBBLE_LEAD_MINUTES,
  parseBlockRoster,
  type BlockRosterMember,
} from '../schemas/index.js';
import { addDays, type LocalDate } from '../time/local-date.js';
import { computePeriodWindow } from '../time/period-window.js';
import {
  BaseBlockInputError,
  buildBaseBlockDraft,
  type BaseBlockDraft,
  type BaseBlockInput,
  type QualifyingDay,
  type RunMember,
  type RunPeriod,
  type RunPeriodOutcome,
} from './base-block.js';
import { evaluatePeriod, type TowerConfig } from './evaluate.js';
import * as evaluator from './index.js';
import { MIN_BLOCK_DAYS, recomputeTowerState } from './recompute.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A daily run of nine survived days, collapsed on the tenth.
const RUN_START: LocalDate = '2026-03-01';
const RUN_END: LocalDate = '2026-03-09';
const RUN_DAYS = 9;
const COLLAPSE_DAY: LocalDate = '2026-03-10';
const AFTER_COLLAPSE: LocalDate = '2026-03-11';
const LONG_AGO: LocalDate = '2026-01-05';

/** n consecutive daily periods from start. */
function periodsFrom(start: LocalDate, n: number, outcome: RunPeriodOutcome = 'survived') {
  return Array.from({ length: n }, (_, i): RunPeriod => ({
    periodStart: addDays(start, i),
    periodEnd: addDays(start, i),
    outcome,
  }));
}

/** n consecutive qualifying days from start. */
function daysOf(start: LocalDate, n: number, tierIndex = 0): QualifyingDay[] {
  return Array.from({ length: n }, (_, i) => ({ localDate: addDays(start, i), tierIndex }));
}

const RUN = periodsFrom(RUN_START, RUN_DAYS);

/** A valid v4-shaped uuid per member number, so the roster passes blockRosterSchema. */
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/** A member for the whole run who qualified every day of it. */
const runMember = (n: number, o: Partial<RunMember> = {}): RunMember => ({
  userId: uid(n),
  displayName: `Member ${n}`,
  joinedOn: LONG_AGO,
  leftOn: null,
  dormantSpans: [],
  qualifyingDays: daysOf(RUN_START, RUN_DAYS),
  ...o,
});

const build = (o: Partial<BaseBlockInput> = {}) =>
  buildBaseBlockDraft({
    ordinal: 1,
    minBlockDays: MIN_BLOCK_DAYS,
    runPeriods: RUN,
    members: [runMember(1)],
    ...o,
  });

/** build, asserting a block came back. */
function block(o: Partial<BaseBlockInput> = {}): BaseBlockDraft {
  const d = build(o);
  expect(d).not.toBeNull();
  return d!;
}

const entryFor = (d: BaseBlockDraft, n: number): BlockRosterMember | undefined =>
  d.roster.find((m) => m.user_id === uid(n));

/** The roster entry a member gets with every field spelled out. */
const rosterEntry = (n: number, o: Partial<BlockRosterMember> = {}): BlockRosterMember => ({
  user_id: uid(n),
  display_name: `Member ${n}`,
  qualifying_days: RUN_DAYS,
  total_days: RUN_DAYS,
  highest_tier: 0,
  was_dormant: false,
  periods_present: RUN_DAYS,
  ...o,
});

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

const DRAFT_KEYS = [
  'heightDays',
  'ordinal',
  'periodsSurvived',
  'roster',
  'runEndDate',
  'runStartDate',
];

const ROSTER_MEMBER_KEYS = [
  'display_name',
  'highest_tier',
  'periods_present',
  'qualifying_days',
  'total_days',
  'user_id',
  'was_dormant',
];

// ---------------------------------------------------------------------------
// Bounds and height
// ---------------------------------------------------------------------------

describe('run bounds, heightDays and periodsSurvived', () => {
  it('a full daily run → the whole draft, every field', () => {
    expect(build()).toEqual({
      ordinal: 1,
      runStartDate: RUN_START,
      runEndDate: RUN_END,
      heightDays: RUN_DAYS,
      periodsSurvived: RUN_DAYS,
      roster: [rosterEntry(1)],
    });
  });

  it('daily: heightDays == periodsSurvived == the survived period count', () => {
    for (const n of [MIN_BLOCK_DAYS, 10, 40]) {
      const d = block({ runPeriods: periodsFrom(RUN_START, n) });
      expect(d.heightDays).toBe(n);
      expect(d.periodsSurvived).toBe(n);
      expect(d.runEndDate).toBe(addDays(RUN_START, n - 1));
    }
  });

  it('runPeriods in any order → the same draft', () => {
    const sorted = build();
    expect(build({ runPeriods: [...RUN].reverse() })).toEqual(sorted);
    expect(build({ runPeriods: [...RUN.slice(4), ...RUN.slice(0, 4)] })).toEqual(sorted);
  });

  it('a hibernated period inside the run widens the bounds but adds no height', () => {
    const runPeriods = [
      ...periodsFrom(RUN_START, 4),
      ...periodsFrom('2026-03-05', 1, 'hibernated'),
      ...periodsFrom('2026-03-06', 4),
    ];
    const qualifyingDays = [...daysOf(RUN_START, 4), ...daysOf('2026-03-06', 4)];
    const d = block({ runPeriods, members: [runMember(1, { qualifyingDays })] });
    expect(d).toMatchObject({
      runStartDate: RUN_START,
      runEndDate: RUN_END,
      heightDays: 8,
      periodsSurvived: 8,
    });
    // Present for all nine calendar days, but only eight of them were survived periods.
    expect(entryFor(d, 1)).toEqual(
      rosterEntry(1, { qualifying_days: 8, total_days: 9, periods_present: 8 })
    );
  });

  it('a freebie period counts like a hibernated one', () => {
    const runPeriods = [
      ...periodsFrom(RUN_START, 4),
      ...periodsFrom('2026-03-05', 1, 'freebie'),
      ...periodsFrom('2026-03-06', 4),
    ];
    expect(block({ runPeriods })).toMatchObject({ heightDays: 8, periodsSurvived: 8 });
  });

  it('a run that opens with a hibernated period starts at that period', () => {
    const runPeriods = [
      ...periodsFrom(RUN_START, 2, 'hibernated'),
      ...periodsFrom('2026-03-03', 7),
    ];
    expect(block({ runPeriods })).toMatchObject({
      runStartDate: RUN_START,
      runEndDate: RUN_END,
      heightDays: 7,
      periodsSurvived: 7,
    });
  });

  // heightDays is days, not periods, so the v2 weekly path is a data change.
  it('a multi-day survived period counts its days toward heightDays, once toward periodsSurvived', () => {
    const week: RunPeriod = {
      periodStart: '2026-03-02',
      periodEnd: '2026-03-08',
      outcome: 'survived',
    };
    const d = block({
      runPeriods: [week],
      members: [runMember(1, { qualifyingDays: daysOf('2026-03-02', 3) })],
    });
    expect(d).toMatchObject({
      runStartDate: '2026-03-02',
      runEndDate: '2026-03-08',
      heightDays: 7,
      periodsSurvived: 1,
    });
    expect(entryFor(d, 1)).toEqual(
      rosterEntry(1, { qualifying_days: 3, total_days: 7, periods_present: 1 })
    );
  });

  it('agrees with recomputeTowerState on the same ledger', () => {
    const ledger = [
      ...RUN.map((p) => ({ ...p, state: 'evaluated' as const })),
      {
        periodStart: COLLAPSE_DAY,
        periodEnd: COLLAPSE_DAY,
        state: 'evaluated' as const,
        outcome: 'collapsed' as const,
      },
    ];
    const [oracle] = recomputeTowerState(ledger).blocks;
    const d = block();
    expect({
      runStartDate: d.runStartDate,
      runEndDate: d.runEndDate,
      blockHeight: d.heightDays,
    }).toEqual(oracle);
  });

  it("agrees with evaluatePeriod's baseBlock boundaries for the collapse that closed the run", () => {
    const tower: TowerConfig = {
      periodUnit: 'day',
      timezone: 'America/Edmonton',
      deadlineTime: '22:00',
      graceWindowMinutes: 60,
      wobbleLeadMinutes: DEFAULT_WOBBLE_LEAD_MINUTES,
      nudgeLeadMinutes: DEFAULT_NUDGE_LEAD_MINUTES,
      weekResetDay: null,
      quota: 1,
      height: RUN_DAYS,
      currentStreak: RUN_DAYS,
      runStartDate: RUN_START,
    };
    const window = computePeriodWindow(tower, COLLAPSE_DAY);
    const out = evaluatePeriod({
      now: window.evaluateAt,
      tower,
      window,
      members: [
        {
          membershipId: 'm1',
          state: 'active',
          qualifyingDays: 0,
          excused: false,
          consecutiveMisses: 0,
        },
      ],
    });
    expect(out.periodStatus).toBe('collapsed');
    const d = block();
    expect(out.baseBlock).toEqual({
      runStartDate: d.runStartDate,
      runEndDate: d.runEndDate,
      blockHeight: d.heightDays,
    });
  });
});

// ---------------------------------------------------------------------------
// Minimum run length, from config
// ---------------------------------------------------------------------------

describe('minimum run length comes from minBlockDays, not a literal', () => {
  it.each([MIN_BLOCK_DAYS, 1, 5, 12])(
    'minBlockDays %s: a run of exactly that many days → a block',
    (min) => {
      const d = block({
        minBlockDays: min,
        runPeriods: periodsFrom(RUN_START, min),
        members: [runMember(1, { qualifyingDays: daysOf(RUN_START, min) })],
      });
      expect(d.heightDays).toBe(min);
    }
  );

  it.each([MIN_BLOCK_DAYS, 2, 5, 12])('minBlockDays %s: one day shorter → null', (min) => {
    expect(build({ minBlockDays: min, runPeriods: periodsFrom(RUN_START, min - 1) })).toBeNull();
  });

  it('minBlockDays 5 rejects a 4-day run that MIN_BLOCK_DAYS would accept', () => {
    const runPeriods = periodsFrom(RUN_START, 4);
    expect(build({ minBlockDays: MIN_BLOCK_DAYS, runPeriods })).not.toBeNull();
    expect(build({ minBlockDays: 5, runPeriods })).toBeNull();
  });

  it('minBlockDays 1 accepts a 2-day run that MIN_BLOCK_DAYS would reject', () => {
    const runPeriods = periodsFrom(RUN_START, 2);
    expect(build({ minBlockDays: MIN_BLOCK_DAYS, runPeriods })).toBeNull();
    expect(build({ minBlockDays: 1, runPeriods })?.heightDays).toBe(2);
  });

  it('the minimum is measured in heightDays: hibernated days do not count toward it', () => {
    const runPeriods = [
      ...periodsFrom(RUN_START, 1),
      ...periodsFrom('2026-03-02', 1, 'hibernated'),
      ...periodsFrom('2026-03-03', 1),
    ];
    expect(build({ minBlockDays: 3, runPeriods })).toBeNull();
    expect(build({ minBlockDays: 2, runPeriods })?.heightDays).toBe(2);
  });

  it('an empty run → null, with members or without', () => {
    expect(build({ runPeriods: [] })).toBeNull();
    expect(build({ runPeriods: [], members: [] })).toBeNull();
  });

  it('a short run with no overlapping members → null, not a roster error', () => {
    expect(build({ runPeriods: periodsFrom(RUN_START, 2), members: [] })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Ordinal
// ---------------------------------------------------------------------------

describe('ordinal is supplied by the caller', () => {
  it.each([1, 7, 42])('ordinal %s is echoed verbatim', (ordinal) => {
    expect(block({ ordinal }).ordinal).toBe(ordinal);
  });

  it('two calls differing only in ordinal differ only in ordinal', () => {
    const a = block({ ordinal: 1 });
    const b = block({ ordinal: 7 });
    expect(b).toEqual({ ...a, ordinal: 7 });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'ordinal %p → BaseBlockInputError',
    (ordinal) => {
      const e = thrown(() => build({ ordinal }));
      expect(e).toBeInstanceOf(BaseBlockInputError);
      expect(e).toMatchObject({ name: 'BaseBlockInputError', field: 'ordinal' });
    }
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'minBlockDays %p → BaseBlockInputError',
    (minBlockDays) => {
      const e = thrown(() => build({ minBlockDays }));
      expect(e).toBeInstanceOf(BaseBlockInputError);
      expect(e).toMatchObject({ field: 'minBlockDays' });
    }
  );

  it('an invalid ordinal throws even when the run is too short for a block', () => {
    expect(() => build({ ordinal: 0, runPeriods: periodsFrom(RUN_START, 1) })).toThrow(
      BaseBlockInputError
    );
  });
});

// ---------------------------------------------------------------------------
// Who is on the roster
// ---------------------------------------------------------------------------

describe('roster: every member who held a membership during the run', () => {
  const members = {
    full: runMember(1),
    joinedMidRun: runMember(2, { joinedOn: '2026-03-05', qualifyingDays: daysOf('2026-03-05', 5) }),
    leftMidRun: runMember(3, { leftOn: '2026-03-04', qualifyingDays: daysOf(RUN_START, 4) }),
    dormantMidRun: runMember(4, {
      dormantSpans: [{ from: '2026-03-03', to: '2026-03-06' }],
      qualifyingDays: [...daysOf(RUN_START, 2), ...daysOf('2026-03-07', 3)],
    }),
    dormantThroughout: runMember(5, {
      dormantSpans: [{ from: '2026-02-20', to: null }],
      qualifyingDays: [],
    }),
    leftBeforeRun: runMember(6, { leftOn: '2026-02-28', qualifyingDays: [] }),
    joinedOnCollapseDay: runMember(7, { joinedOn: COLLAPSE_DAY, qualifyingDays: [] }),
    joinedOnLastDay: runMember(8, { joinedOn: RUN_END, qualifyingDays: daysOf(RUN_END, 1) }),
    leftOnFirstDay: runMember(9, { leftOn: RUN_START, qualifyingDays: daysOf(RUN_START, 1) }),
  };
  const d = () => block({ members: Object.values(members) });

  it('includes everyone whose membership overlaps the run, and no one else', () => {
    expect(d().roster.map((m) => m.user_id)).toEqual([1, 2, 3, 4, 5, 8, 9].map(uid));
  });

  it('a full-run member', () => {
    expect(entryFor(d(), 1)).toEqual(rosterEntry(1));
  });

  it('a member who joined mid-run counts from their join day', () => {
    expect(entryFor(d(), 2)).toEqual(
      rosterEntry(2, { qualifying_days: 5, total_days: 5, periods_present: 5 })
    );
  });

  it('a member who left mid-run counts through their last day', () => {
    expect(entryFor(d(), 3)).toEqual(
      rosterEntry(3, { qualifying_days: 4, total_days: 4, periods_present: 4 })
    );
  });

  it('a member who went dormant mid-run and came back is on it, was_dormant', () => {
    expect(entryFor(d(), 4)).toEqual(rosterEntry(4, { qualifying_days: 5, was_dormant: true }));
  });

  it('a member dormant for the whole run is on it, with no qualifying days', () => {
    expect(entryFor(d(), 5)).toEqual(
      rosterEntry(5, { qualifying_days: 0, highest_tier: 0, was_dormant: true })
    );
  });

  it('one-day overlaps at either edge of the run count', () => {
    expect(entryFor(d(), 8)).toEqual(
      rosterEntry(8, { qualifying_days: 1, total_days: 1, periods_present: 1 })
    );
    expect(entryFor(d(), 9)).toEqual(
      rosterEntry(9, { qualifying_days: 1, total_days: 1, periods_present: 1 })
    );
  });

  it('every roster passes blockRosterSchema', () => {
    const r = parseBlockRoster(d().roster);
    expect(r).toEqual({ ok: true, roster: d().roster });
  });

  it.each([
    ['before the run', [{ from: '2026-02-01', to: '2026-02-28' }], false],
    ['ending on its first day', [{ from: '2026-02-01', to: RUN_START }], true],
    ['starting on its last day', [{ from: RUN_END, to: null }], true],
    ['starting on the collapse day', [{ from: COLLAPSE_DAY, to: null }], false],
    ['starting after the collapse', [{ from: AFTER_COLLAPSE, to: null }], false],
    [
      'two spans, one inside',
      [
        { from: '2026-02-01', to: '2026-02-02' },
        { from: '2026-03-04', to: '2026-03-04' },
      ],
      true,
    ],
  ] as const)('a dormancy %s (%j) → was_dormant %s', (_label, dormantSpans, wasDormant) => {
    const out = block({ members: [runMember(1, { dormantSpans: [...dormantSpans] })] });
    expect(entryFor(out, 1)!.was_dormant).toBe(wasDormant);
  });
});

// ---------------------------------------------------------------------------
// Per-member statistics
// ---------------------------------------------------------------------------

describe('per-member statistics are clipped to run ∩ membership', () => {
  it('qualifying days outside the run are ignored, and so are their tiers', () => {
    const qualifyingDays = [
      ...daysOf('2026-02-20', 9, 5), // 02-20..02-28: before the run
      ...daysOf(RUN_START, RUN_DAYS, 1),
      ...daysOf(COLLAPSE_DAY, 2, 5), // the collapse day and after
    ];
    expect(entryFor(block({ members: [runMember(1, { qualifyingDays })] }), 1)).toEqual(
      rosterEntry(1, { highest_tier: 1 })
    );
  });

  it('qualifying days outside the membership are ignored', () => {
    const m = runMember(1, {
      joinedOn: '2026-03-03',
      leftOn: '2026-03-06',
      qualifyingDays: daysOf(RUN_START, RUN_DAYS, 2).map((q) =>
        q.localDate >= '2026-03-03' && q.localDate <= '2026-03-06' ? { ...q, tierIndex: 0 } : q
      ),
    });
    expect(entryFor(block({ members: [m] }), 1)).toEqual(
      rosterEntry(1, { qualifying_days: 4, total_days: 4, periods_present: 4, highest_tier: 0 })
    );
  });

  it('several qualifying records on one date count as one day, at the highest tier', () => {
    const qualifyingDays = [
      { localDate: '2026-03-02', tierIndex: 0 },
      { localDate: '2026-03-02', tierIndex: 2 },
      { localDate: '2026-03-02', tierIndex: 1 },
      { localDate: '2026-03-03', tierIndex: 1 },
    ];
    expect(entryFor(block({ members: [runMember(1, { qualifyingDays })] }), 1)).toMatchObject({
      qualifying_days: 2,
      highest_tier: 2,
    });
  });

  it('highest_tier is the max over the run', () => {
    const qualifyingDays = [
      ...daysOf(RUN_START, 3, 1),
      { localDate: '2026-03-04', tierIndex: 4 },
      ...daysOf('2026-03-05', 5, 2),
    ];
    expect(entryFor(block({ members: [runMember(1, { qualifyingDays })] }), 1)!.highest_tier).toBe(
      4
    );
  });

  it('highest_tier is 0 when nothing qualified', () => {
    expect(entryFor(block({ members: [runMember(1, { qualifyingDays: [] })] }), 1)).toMatchObject({
      qualifying_days: 0,
      highest_tier: 0,
    });
  });

  it('qualifying_days is per member, not the tower height', () => {
    const d = block({ members: [runMember(1, { qualifyingDays: daysOf(RUN_START, 2) })] });
    expect(d.heightDays).toBe(RUN_DAYS);
    expect(entryFor(d, 1)!.qualifying_days).toBe(2);
  });

  it('display_name is taken as given', () => {
    const d = block({ members: [runMember(1, { displayName: 'Sam' })] });
    expect(entryFor(d, 1)!.display_name).toBe('Sam');
  });
});

describe('a block always has a roster', () => {
  it('a long run with no overlapping membership → BaseBlockInputError on members', () => {
    const e = thrown(() =>
      build({
        members: [runMember(6, { leftOn: '2026-02-28' }), runMember(7, { joinedOn: COLLAPSE_DAY })],
      })
    );
    expect(e).toBeInstanceOf(BaseBlockInputError);
    expect(e).toMatchObject({ field: 'members' });
  });

  it('a long run with no members at all → BaseBlockInputError on members', () => {
    expect(thrown(() => build({ members: [] }))).toMatchObject({ field: 'members' });
  });
});

// ---------------------------------------------------------------------------
// No blame (§5)
// ---------------------------------------------------------------------------

describe('no field identifies who caused the collapse (§5)', () => {
  const crew = [
    runMember(3),
    runMember(1, { qualifyingDays: daysOf(RUN_START, 7) }),
    runMember(2, { dormantSpans: [{ from: '2026-03-04', to: '2026-03-05' }] }),
  ];

  it('the draft carries exactly its documented keys', () => {
    expect(Object.keys(block({ members: crew })).sort()).toEqual(DRAFT_KEYS);
  });

  it('every roster member carries exactly the schema keys', () => {
    for (const m of block({ members: crew }).roster) {
      expect(Object.keys(m).sort()).toEqual(ROSTER_MEMBER_KEYS);
    }
  });

  it('the roster is sorted by user_id, whatever the input order', () => {
    const d = block({ members: crew });
    expect(d.roster.map((m) => m.user_id)).toEqual([1, 2, 3].map(uid));
    expect(block({ members: [...crew].reverse() })).toEqual(d);
    expect(block({ members: [crew[1]!, crew[2]!, crew[0]!] })).toEqual(d);
  });

  it('stray input fields never reach the output', () => {
    const clean = block({ members: crew });
    const dirty = crew.map(
      (m, i) =>
        ({
          ...m,
          causedCollapse: i === 0,
          caused_collapse: i === 0,
          state: i === 0 ? 'at_risk' : 'active',
          consecutiveMisses: i === 0 ? 1 : 0,
          missedBy: [uid(3)],
          membershipId: `membership-${i}`,
        }) as RunMember
    );
    const out = block({ members: dirty });
    expect(out).toEqual(clean);
    const json = JSON.stringify(out);
    for (const word of [
      'causedCollapse',
      'caused_collapse',
      'missedBy',
      'missed_by',
      'consecutiveMisses',
      'at_risk',
      '"state"',
      'membership-',
    ]) {
      expect(json).not.toContain(word);
    }
  });

  it('the collapser and a twin who logged on the collapse day are indistinguishable', () => {
    // Identical in-run history. Only `logged` qualified on the collapse day;
    // `collapser` didn't and went at_risk from the next day.
    const logged = runMember(1, { qualifyingDays: daysOf(RUN_START, RUN_DAYS + 1) });
    const collapser = runMember(2, { dormantSpans: [{ from: AFTER_COLLAPSE, to: null }] });
    const d = block({ members: [collapser, logged] });
    const strip = ({ user_id, display_name, ...rest }: BlockRosterMember) => {
      void [user_id, display_name];
      return rest;
    };
    expect(strip(entryFor(d, 1)!)).toEqual(strip(entryFor(d, 2)!));
  });

  it('nothing about the collapsing period is an input', () => {
    // The type has no slot for it; a stray one is ignored like any other field.
    const withCollapse = {
      ordinal: 1,
      minBlockDays: MIN_BLOCK_DAYS,
      runPeriods: RUN,
      members: crew,
      collapsedPeriod: { periodStart: COLLAPSE_DAY, periodEnd: COLLAPSE_DAY, missedBy: [uid(1)] },
    } as BaseBlockInput;
    expect(buildBaseBlockDraft(withCollapse)).toEqual(block({ members: crew }));
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe('pure', () => {
  const input = (): BaseBlockInput => ({
    ordinal: 3,
    minBlockDays: MIN_BLOCK_DAYS,
    runPeriods: [...RUN].reverse(),
    members: [
      runMember(2, { dormantSpans: [{ from: '2026-03-02', to: '2026-03-03' }] }),
      runMember(1, { qualifyingDays: [...daysOf(RUN_START, 4, 1)].reverse() }),
    ],
  });

  it('the same input → the same output', () => {
    expect(buildBaseBlockDraft(input())).toEqual(buildBaseBlockDraft(input()));
  });

  it('does not mutate its input', () => {
    const i = input();
    const before = structuredClone(i);
    buildBaseBlockDraft(i);
    expect(i).toEqual(before);
  });

  it('accepts a deeply frozen input', () => {
    expect(buildBaseBlockDraft(deepFreeze(input()))).toEqual(buildBaseBlockDraft(input()));
  });
});

describe('barrel', () => {
  it('exports buildBaseBlockDraft and BaseBlockInputError from the evaluator index', () => {
    expect(evaluator.buildBaseBlockDraft).toBe(buildBaseBlockDraft);
    expect(evaluator.BaseBlockInputError).toBe(BaseBlockInputError);
  });
});
