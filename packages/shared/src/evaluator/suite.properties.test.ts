import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { runEvaluatorFixture, type EvaluatorFixture } from '../testing/evaluator-fixtures.js';
import { addDays, type LocalDate } from '../time/local-date.js';
import { computePeriodWindow } from '../time/period-window.js';
import { buildBaseBlockDraft, type RunPeriod } from './base-block.js';
import {
  evaluatePeriod,
  type EvaluationInput,
  type EvaluationStatus,
  type MemberPeriodState,
  type TowerConfig,
} from './evaluate.js';
import { MIN_BLOCK_DAYS } from './recompute.js';

/*
 * 2.7 invariants as properties. evaluate.test.ts sweeps a fixed grid of
 * rosters and instants; these draw zones, deadlines, leads, run heights and
 * period dates as well, weighted toward DST transitions.
 *
 * Fixed seed: a red run is reproducible from the printed counterexample, and
 * CI never flakes. Change PARAMS.seed locally to explore.
 */

const PARAMS = { seed: 0x2_07, numRuns: 200 } as const;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const ZONES = [
  'America/Edmonton',
  'America/Toronto',
  'America/Regina',
  'Pacific/Chatham',
  'Asia/Kolkata',
  'America/Santiago',
  'UTC',
] as const;

/** Includes times that fall in a gap or an overlap somewhere in ZONES. */
const DEADLINES = ['22:00', '23:59', '00:30', '01:30', '02:30', '03:00', '12:00', '24:00'];

/** Transition days (both directions) in ZONES, plus ordinary ones. */
const DST_DATES: LocalDate[] = [
  '2026-03-08',
  '2026-11-01',
  '2027-03-14',
  '2027-11-07',
  '2027-04-04',
  '2027-09-26',
  '2026-04-05',
  '2026-09-06',
];

const arbPeriodStart: fc.Arbitrary<LocalDate> = fc.oneof(
  fc.constantFrom(...DST_DATES),
  fc.integer({ min: 0, max: 730 }).map((d) => addDays('2026-01-01', d))
);

const arbTower = (periodStart: LocalDate): fc.Arbitrary<TowerConfig> =>
  fc
    .record({
      timezone: fc.constantFrom(...ZONES),
      deadlineTime: fc.constantFrom(...DEADLINES),
      graceWindowMinutes: fc.integer({ min: 0, max: 180 }),
      wobbleLeadMinutes: fc.integer({ min: 0, max: 360 }),
      nudgeLeadMinutes: fc.integer({ min: 0, max: 720 }),
      quota: fc.constant(1),
      currentStreak: fc.integer({ min: 0, max: 20 }),
      extraHeight: fc.integer({ min: 0, max: 20 }),
      // Sometimes null even with a currentStreak, to probe the block guard.
      hasRun: fc.boolean(),
    })
    .map(({ hasRun, extraHeight, ...t }) => ({
      ...t,
      height: t.currentStreak + extraHeight,
      periodUnit: 'day' as const,
      weekResetDay: null,
      runStartDate: hasRun && t.currentStreak > 0 ? addDays(periodStart, -t.currentStreak) : null,
    }));

const arbMember = (i: number): fc.Arbitrary<MemberPeriodState> =>
  fc
    .record({
      state: fc.constantFrom('active', 'at_risk', 'dormant', 'removed'),
      qualifyingDays: fc.integer({ min: 0, max: 2 }),
      excused: fc.boolean(),
      extraMisses: fc.integer({ min: 0, max: 3 }),
    })
    .map(({ state, extraMisses, ...rest }) => ({
      membershipId: `m${i}`,
      state,
      ...rest,
      // Consistent with the state: active 0, at_risk >= 1, dormant >= 2.
      consecutiveMisses:
        state === 'active'
          ? 0
          : state === 'at_risk'
            ? 1 + extraMisses
            : state === 'dormant'
              ? 2 + extraMisses
              : 0,
    }));

const arbMembers: fc.Arbitrary<MemberPeriodState[]> = fc
  .integer({ min: 1, max: 6 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => arbMember(i))));

/** A full input minus `now`. */
const arbCase = arbPeriodStart.chain((periodStart) =>
  fc.record({
    periodStart: fc.constant(periodStart),
    tower: arbTower(periodStart),
    members: arbMembers,
  })
);

type Case = { periodStart: LocalDate; tower: TowerConfig; members: MemberPeriodState[] };

const inputAt = (c: Case, now: string): EvaluationInput => ({
  now,
  tower: c.tower,
  window: computePeriodWindow(c.tower, c.periodStart),
  members: c.members,
});

/** Offsets from evaluateAt, in ms, covering the day before through the day after. */
const arbOffsets = fc.array(fc.integer({ min: -2 * DAY_MS, max: DAY_MS }), {
  minLength: 1,
  maxLength: 12,
});

const RANK: Record<EvaluationStatus, number> = { open: 0, wobbling: 1, survived: 2, collapsed: 2 };

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.values(o).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('property: monotonic in now (open → wobbling → terminal)', () => {
  it('for fixed member state, status rank never decreases as now advances', () => {
    fc.assert(
      fc.property(arbCase, arbOffsets, (c, offsets) => {
        const w = computePeriodWindow(c.tower, c.periodStart);
        const evalMs = Date.parse(w.evaluateAt);
        const wobbleMs = Date.parse(w.wobbleAt);
        const instants = [
          ...offsets.map((o) => evalMs + o),
          wobbleMs - 1,
          wobbleMs,
          evalMs - 1,
          evalMs,
        ].sort((a, b) => a - b);
        const outs = instants.map((t) => evaluatePeriod(inputAt(c, new Date(t).toISOString())));
        for (let i = 1; i < outs.length; i++) {
          expect(RANK[outs[i]!.periodStatus]).toBeGreaterThanOrEqual(
            RANK[outs[i - 1]!.periodStatus]
          );
        }
      }),
      PARAMS
    );
  });

  it('every now >= evaluateAt gives one deep-equal decision; collapsed never before it', () => {
    fc.assert(
      fc.property(arbCase, arbOffsets, (c, offsets) => {
        const w = computePeriodWindow(c.tower, c.periodStart);
        const evalMs = Date.parse(w.evaluateAt);
        const at = (t: number) => evaluatePeriod(inputAt(c, new Date(t).toISOString()));
        const decided = at(evalMs);
        for (const o of offsets) {
          const out = at(evalMs + o);
          if (o >= 0) expect(out).toStrictEqual(decided);
          else expect(out.periodStatus).not.toBe('collapsed');
        }
      }),
      PARAMS
    );
  });

  it('an early survived (before wobbleAt) holds at every later now', () => {
    fc.assert(
      fc.property(arbCase, arbOffsets, (c, offsets) => {
        const w = computePeriodWindow(c.tower, c.periodStart);
        const early = Date.parse(w.wobbleAt) - 1;
        fc.pre(
          evaluatePeriod(inputAt(c, new Date(early).toISOString())).periodStatus === 'survived'
        );
        const evalMs = Date.parse(w.evaluateAt);
        for (const o of offsets) {
          const t = Math.max(early, evalMs + o);
          expect(evaluatePeriod(inputAt(c, new Date(t).toISOString())).periodStatus).toBe(
            'survived'
          );
        }
      }),
      PARAMS
    );
  });
});

describe('property: deterministic', () => {
  it('identical input → deeply equal output across repeated calls', () => {
    fc.assert(
      fc.property(arbCase, fc.integer({ min: -2 * DAY_MS, max: DAY_MS }), (c, o) => {
        const w = computePeriodWindow(c.tower, c.periodStart);
        const input = inputAt(c, new Date(Date.parse(w.evaluateAt) + o).toISOString());
        const a = evaluatePeriod(structuredClone(input));
        const b = evaluatePeriod(structuredClone(input));
        const c2 = evaluatePeriod(input);
        expect(b).toStrictEqual(a);
        expect(c2).toStrictEqual(a);
      }),
      PARAMS
    );
  });

  it('a deep-frozen input is accepted unchanged (no mutation)', () => {
    fc.assert(
      fc.property(arbCase, fc.integer({ min: -2 * DAY_MS, max: DAY_MS }), (c, o) => {
        const w = computePeriodWindow(c.tower, c.periodStart);
        const input = inputAt(c, new Date(Date.parse(w.evaluateAt) + o).toISOString());
        const before = structuredClone(input);
        const out = evaluatePeriod(deepFreeze(structuredClone(input)));
        expect(out).toStrictEqual(evaluatePeriod(before));
        expect(input).toStrictEqual(before);
      }),
      PARAMS
    );
  });
});

describe('property: never collapsed with a zero-height base block', () => {
  it('evaluatePeriod: a block on collapse has blockHeight >= MIN_BLOCK_DAYS > 0', () => {
    fc.assert(
      fc.property(arbCase, fc.integer({ min: -2 * DAY_MS, max: DAY_MS }), (c, o) => {
        const w = computePeriodWindow(c.tower, c.periodStart);
        const out = evaluatePeriod(
          inputAt(c, new Date(Date.parse(w.evaluateAt) + o).toISOString())
        );
        if (out.baseBlock !== undefined) {
          expect(out.periodStatus).toBe('collapsed');
          expect(out.baseBlock.blockHeight).toBeGreaterThan(0);
          expect(out.baseBlock.blockHeight).toBeGreaterThanOrEqual(MIN_BLOCK_DAYS);
          expect(out.baseBlock.runStartDate <= out.baseBlock.runEndDate).toBe(true);
        }
      }),
      PARAMS
    );
  });

  it('buildBaseBlockDraft: null or heightDays >= minBlockDays >= 1, over any run', () => {
    const arbRunPeriods = fc
      .array(fc.constantFrom<RunPeriod['outcome']>('survived', 'hibernated', 'freebie'), {
        maxLength: 12,
      })
      .map((outcomes) =>
        outcomes.map((outcome, i): RunPeriod => {
          const d = addDays('2026-03-01', i);
          return { periodStart: d, periodEnd: d, outcome };
        })
      );
    fc.assert(
      fc.property(arbRunPeriods, fc.integer({ min: 1, max: 6 }), (runPeriods, minBlockDays) => {
        const draft = buildBaseBlockDraft({
          ordinal: 1,
          minBlockDays,
          runPeriods,
          members: [
            {
              userId: '00000000-0000-4000-8000-000000000001',
              displayName: 'Sam',
              joinedOn: '2020-01-01',
              leftOn: null,
              dormantSpans: [],
              qualifyingDays: [],
            },
          ],
        });
        if (draft !== null) {
          expect(draft.heightDays).toBeGreaterThanOrEqual(minBlockDays);
          expect(draft.heightDays).toBeGreaterThan(0);
        }
      }),
      PARAMS
    );
  });

  it('full pipeline: collapsed ⇒ no draft, or a draft whose heightDays matches the block', () => {
    fc.assert(
      fc.property(arbCase, (c) => {
        const fixture: EvaluatorFixture = {
          name: 'property',
          group: 'single miss',
          tower: c.tower,
          periodStart: c.periodStart,
          now: 'decided',
          members: c.members,
          expect: {
            periodStatus: 'collapsed',
            transitions: [],
            baseBlock: null,
            draftHeightDays: null,
          },
        };
        const r = runEvaluatorFixture(fixture);
        if (r.output.periodStatus !== 'collapsed') {
          expect(r.draft).toBeNull();
          return;
        }
        if (r.draft === null) {
          expect(r.output.baseBlock).toBeUndefined();
          return;
        }
        expect(r.draft.heightDays).toBeGreaterThan(0);
        expect(r.output.baseBlock?.blockHeight).toBe(r.draft.heightDays);
      }),
      PARAMS
    );
  });
});
