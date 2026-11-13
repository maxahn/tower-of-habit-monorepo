import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NUDGE_LEAD_MINUTES, DEFAULT_WOBBLE_LEAD_MINUTES } from '../schemas/index.js';
import type { MembershipState } from '../schemas/index.js';
import { addDays, type LocalDate } from '../time/local-date.js';
import { computePeriodWindow } from '../time/period-window.js';
import {
  evaluatePeriod,
  type EvaluationInput,
  type EvaluationOutput,
  type EvaluationWindow,
  type MemberPeriodState,
  type MemberStanding,
  type MembershipTransition,
  type TowerConfig,
} from './evaluate.js';
import * as evaluator from './index.js';
import { MIN_BLOCK_DAYS } from './recompute.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MS = 1;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const TOWER: TowerConfig = {
  periodUnit: 'day',
  timezone: 'America/Edmonton',
  deadlineTime: '22:00',
  // Non-zero, so the grace window [deadlineAt, evaluateAt) is a real phase.
  graceWindowMinutes: 60,
  wobbleLeadMinutes: DEFAULT_WOBBLE_LEAD_MINUTES,
  nudgeLeadMinutes: DEFAULT_NUDGE_LEAD_MINUTES,
  weekResetDay: null,
  quota: 1,
  height: 0,
  runStartDate: null,
};

const PERIOD_START: LocalDate = '2026-03-10';
const NEXT_PERIOD_START: LocalDate = '2026-03-11';
// Built with the real 2.2 function, so the instants are the ones production uses.
const WINDOW: EvaluationWindow = computePeriodWindow(TOWER, PERIOD_START);

const shift = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();

/** The same instant written with a numeric UTC offset instead of 'Z'. */
function withOffset(iso: string, offsetMinutes: number): string {
  const local = new Date(Date.parse(iso) + offsetMinutes * MINUTE).toISOString().slice(0, -1);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${local}${sign}${hh}:${mm}`;
}

/** Instants grouped by the phase a short member puts the period in. */
function phasesOf(w: EvaluationWindow) {
  return {
    open: [shift(w.nudgeAt, -HOUR), w.nudgeAt, shift(w.wobbleAt, -MS)],
    wobbling: [w.wobbleAt, shift(w.deadlineAt, -MS), w.deadlineAt, shift(w.evaluateAt, -MS)],
    terminal: [
      w.evaluateAt,
      shift(w.evaluateAt, MS),
      shift(w.evaluateAt, HOUR),
      shift(w.evaluateAt, DAY),
      shift(w.evaluateAt, 30 * DAY),
    ],
  };
}

const PHASES = phasesOf(WINDOW);
const BEFORE_WOBBLE = PHASES.open[0]!;
const ALL_INSTANTS = [...PHASES.open, ...PHASES.wobbling, ...PHASES.terminal];

const member = (id: string, o: Partial<MemberPeriodState> = {}): MemberPeriodState => ({
  membershipId: id,
  state: 'active',
  qualifyingDays: 0,
  excused: false,
  consecutiveMisses: 0,
  ...o,
});
/** Met quota (daily: one qualifying day). */
const met = (id: string, o: Partial<MemberPeriodState> = {}) =>
  member(id, { qualifyingDays: 1, ...o });
/** Short of quota. */
const short = (id: string, o: Partial<MemberPeriodState> = {}) =>
  member(id, { qualifyingDays: 0, ...o });
/** at_risk: missed exactly the previous period. */
const atRisk = { state: 'at_risk', consecutiveMisses: 1 } as const;
const dormant = { state: 'dormant', consecutiveMisses: 2 } as const;
const removed = { state: 'removed', consecutiveMisses: 0 } as const;

function inputOf(
  now: string,
  members: MemberPeriodState[],
  tower: Partial<TowerConfig> = {},
  window: EvaluationWindow = WINDOW
): EvaluationInput {
  return { now, tower: { ...TOWER, ...tower }, window, members };
}

const evaluate = (
  now: string,
  members: MemberPeriodState[],
  tower: Partial<TowerConfig> = {},
  window: EvaluationWindow = WINDOW
): EvaluationOutput => evaluatePeriod(inputOf(now, members, tower, window));

const standings = (out: EvaluationOutput): Record<string, MemberStanding> =>
  Object.fromEntries(out.perMember.map((m) => [m.membershipId, m.standing]));

const named = (out: EvaluationOutput, standing: MemberStanding): string[] =>
  out.perMember.filter((m) => m.standing === standing).map((m) => m.membershipId);

/** Transition order is not part of the contract; compare as sets. */
const sortedTransitions = (out: EvaluationOutput): MembershipTransition[] =>
  [...out.transitions].sort((a, b) => a.membershipId.localeCompare(b.membershipId));

afterEach(() => {
  vi.useRealTimers();
});

// Fixture guard, not a test: a broken fixture fails every test, but nothing
// here passes on its own before evaluatePeriod exists.
beforeAll(() => {
  const t = [WINDOW.nudgeAt, WINDOW.wobbleAt, WINDOW.deadlineAt, WINDOW.evaluateAt].map(Date.parse);
  expect([...t].sort((a, b) => a - b)).toEqual(t);
  expect(new Set(t).size).toBe(4);
  expect(WINDOW.periodStart).toBe(PERIOD_START);
  expect(WINDOW.periodEnd).toBe(PERIOD_START);
});

// ---------------------------------------------------------------------------
// Status by phase
// ---------------------------------------------------------------------------

describe('open: now < wobbleAt and quota unmet', () => {
  it.each(PHASES.open)('now = %s → open', (now) => {
    expect(evaluate(now, [short('a')]).periodStatus).toBe('open');
  });

  it('one met, one short → still open before wobbleAt', () => {
    expect(evaluate(BEFORE_WOBBLE, [met('a'), short('b')]).periodStatus).toBe('open');
  });

  it('wobbleAt - 1ms is the last open instant', () => {
    expect(evaluate(shift(WINDOW.wobbleAt, -MS), [short('a')]).periodStatus).toBe('open');
    expect(evaluate(WINDOW.wobbleAt, [short('a')]).periodStatus).toBe('wobbling');
  });
});

describe('wobbling: wobbleAt <= now < evaluateAt, a counted member short', () => {
  it.each(PHASES.wobbling)('now = %s → wobbling', (now) => {
    expect(evaluate(now, [short('a')]).periodStatus).toBe('wobbling');
  });

  it('the grace window (deadlineAt..evaluateAt) is still wobbling, not collapsed', () => {
    expect(evaluate(WINDOW.deadlineAt, [short('a')]).periodStatus).toBe('wobbling');
    expect(evaluate(shift(WINDOW.evaluateAt, -MS), [short('a')]).periodStatus).toBe('wobbling');
  });

  it('names exactly the short members in perMember', () => {
    const out = evaluate(WINDOW.wobbleAt, [met('a'), short('b'), met('c'), short('d')]);
    expect(out.periodStatus).toBe('wobbling');
    expect(named(out, 'short')).toEqual(['b', 'd']);
    expect(named(out, 'met')).toEqual(['a', 'c']);
  });

  it('an at_risk member who is short wobbles like anyone else', () => {
    const out = evaluate(WINDOW.wobbleAt, [met('a'), short('b', atRisk)]);
    expect(out.periodStatus).toBe('wobbling');
    expect(named(out, 'short')).toEqual(['b']);
  });
});

describe('survived: every counted member meets quota, regardless of now', () => {
  it.each(ALL_INSTANTS)('now = %s → survived', (now) => {
    expect(evaluate(now, [met('a'), met('b')]).periodStatus).toBe('survived');
  });

  it('qualifyingDays above quota still counts as met', () => {
    const out = evaluate(WINDOW.evaluateAt, [met('a', { qualifyingDays: 3 })]);
    expect(out.periodStatus).toBe('survived');
    expect(standings(out)).toEqual({ a: 'met' });
  });
});

describe('collapsed: now >= evaluateAt and a counted member short', () => {
  it.each(PHASES.terminal)('now = %s → collapsed', (now) => {
    expect(evaluate(now, [short('a')]).periodStatus).toBe('collapsed');
  });

  it('evaluateAt itself is inclusive', () => {
    expect(evaluate(WINDOW.evaluateAt, [short('a')]).periodStatus).toBe('collapsed');
  });

  it('one short member collapses a tower of otherwise-met members', () => {
    const out = evaluate(WINDOW.evaluateAt, [met('a'), met('b'), short('c')]);
    expect(out.periodStatus).toBe('collapsed');
    expect(named(out, 'short')).toEqual(['c']);
  });
});

describe('now is compared as an instant, not as a string', () => {
  it('evaluateAt written with a -06:00 offset still collapses', () => {
    // As a string this sorts before WINDOW.evaluateAt ('...T23:00' on the 10th
    // vs '...T05:00Z' on the 11th); as an instant it is equal.
    const now = withOffset(WINDOW.evaluateAt, -6 * 60);
    expect(Date.parse(now)).toBe(Date.parse(WINDOW.evaluateAt));
    expect(evaluate(now, [short('a')]).periodStatus).toBe('collapsed');
  });

  it('wobbleAt - 1ms written with a +09:00 offset is still open', () => {
    const now = withOffset(shift(WINDOW.wobbleAt, -MS), 9 * 60);
    expect(evaluate(now, [short('a')]).periodStatus).toBe('open');
  });

  it('a window whose instants carry offsets is read the same way', () => {
    const w: EvaluationWindow = {
      ...WINDOW,
      wobbleAt: withOffset(WINDOW.wobbleAt, -7 * 60),
      evaluateAt: withOffset(WINDOW.evaluateAt, 5 * 60),
    };
    expect(evaluate(shift(WINDOW.wobbleAt, -MS), [short('a')], {}, w).periodStatus).toBe('open');
    expect(evaluate(WINDOW.wobbleAt, [short('a')], {}, w).periodStatus).toBe('wobbling');
    expect(evaluate(WINDOW.evaluateAt, [short('a')], {}, w).periodStatus).toBe('collapsed');
  });
});

// ---------------------------------------------------------------------------
// Excused, dormant, removed, empty
// ---------------------------------------------------------------------------

describe('excused members never cause wobbling or collapsed', () => {
  it.each(ALL_INSTANTS)('excused-short + met at %s → survived', (now) => {
    const out = evaluate(now, [met('a'), short('b', { excused: true })]);
    expect(out.periodStatus).toBe('survived');
    expect(standings(out)).toEqual({ a: 'met', b: 'excused' });
  });

  it.each(PHASES.terminal)('an excused at_risk member is not ladder-stepped at %s', (now) => {
    const out = evaluate(now, [met('a'), short('b', { ...atRisk, excused: true })]);
    expect(out.periodStatus).toBe('survived');
    expect(out.transitions.filter((t) => t.membershipId === 'b')).toEqual([]);
  });

  it('excused does not rescue another member: the non-excused short one still collapses', () => {
    const out = evaluate(WINDOW.evaluateAt, [short('a', { excused: true }), short('b')]);
    expect(out.periodStatus).toBe('collapsed');
    expect(named(out, 'short')).toEqual(['b']);
    expect(named(out, 'excused')).toEqual(['a']);
  });

  it('wobbling names only non-excused short members', () => {
    const out = evaluate(WINDOW.wobbleAt, [short('a', { excused: true }), short('b')]);
    expect(out.periodStatus).toBe('wobbling');
    expect(named(out, 'short')).toEqual(['b']);
  });
});

describe('dormant and removed members are excluded from the quota check', () => {
  it.each(ALL_INSTANTS)('dormant-short + met at %s → survived', (now) => {
    const out = evaluate(now, [met('a'), short('b', dormant)]);
    expect(out.periodStatus).toBe('survived');
    expect(standings(out)).toEqual({ a: 'met', b: 'excluded' });
  });

  it.each(ALL_INSTANTS)('removed-short + met at %s → survived', (now) => {
    const out = evaluate(now, [met('a'), short('b', removed)]);
    expect(out.periodStatus).toBe('survived');
    expect(standings(out)).toEqual({ a: 'met', b: 'excluded' });
  });

  it('a dormant member who logged stays excluded and gets no transition', () => {
    // Returning from dormancy is a user action, not a log.
    const out = evaluate(WINDOW.evaluateAt, [met('a'), met('b', dormant)]);
    expect(standings(out).b).toBe('excluded');
    expect(out.transitions.filter((t) => t.membershipId === 'b')).toEqual([]);
  });

  it('dormant members never appear among the short, even while wobbling', () => {
    const out = evaluate(WINDOW.wobbleAt, [short('a'), short('b', dormant)]);
    expect(out.periodStatus).toBe('wobbling');
    expect(named(out, 'short')).toEqual(['a']);
  });
});

describe('zero counted members → survived, no transitions (hibernation is the caller’s)', () => {
  const cases: [string, MemberPeriodState[]][] = [
    ['no members', []],
    ['all dormant', [short('a', dormant), short('b', dormant)]],
    ['all removed', [short('a', removed)]],
    ['dormant + removed', [short('a', dormant), short('b', removed)]],
    ['all excused', [short('a', { excused: true }), short('b', { ...atRisk, excused: true })]],
  ];

  describe.each(cases)('%s', (_label, members) => {
    it.each(ALL_INSTANTS)('now = %s', (now) => {
      const out = evaluate(now, members, {
        height: MIN_BLOCK_DAYS + 5,
        runStartDate: '2026-03-02',
      });
      expect(out.periodStatus).toBe('survived');
      expect(out.transitions).toEqual([]);
      expect(out).not.toHaveProperty('baseBlock');
    });
  });
});

// ---------------------------------------------------------------------------
// §6 dormancy ladder (transitions)
// ---------------------------------------------------------------------------

describe('§6 ladder', () => {
  it.each([...PHASES.open, ...PHASES.wobbling])(
    'no transitions before a terminal status (%s)',
    (now) => {
      const out = evaluate(now, [short('a'), short('b', atRisk), met('c', atRisk)]);
      expect(['open', 'wobbling']).toContain(out.periodStatus);
      expect(out.transitions).toEqual([]);
    }
  );

  it('miss #1: active member short at evaluateAt → at_risk, and the tower collapses', () => {
    const out = evaluate(WINDOW.evaluateAt, [met('a'), short('b')]);
    expect(out.periodStatus).toBe('collapsed');
    expect(out.transitions).toEqual([{ membershipId: 'b', from: 'active', to: 'at_risk' }]);
  });

  it('miss #2: at_risk member short → dormant (consecutive_miss) INSTEAD of collapsing', () => {
    const out = evaluate(WINDOW.evaluateAt, [met('a'), short('b', atRisk)]);
    expect(out.periodStatus).toBe('survived');
    expect(out.transitions).toEqual([
      { membershipId: 'b', from: 'at_risk', to: 'dormant', reason: 'consecutive_miss' },
    ]);
  });

  it('miss #2 as the only member → survived, and the member goes dormant', () => {
    const out = evaluate(WINDOW.evaluateAt, [short('a', atRisk)]);
    expect(out.periodStatus).toBe('survived');
    expect(out.transitions).toEqual([
      { membershipId: 'a', from: 'at_risk', to: 'dormant', reason: 'consecutive_miss' },
    ]);
  });

  it('miss #2 never leaves a base block, however long the run', () => {
    const out = evaluate(WINDOW.evaluateAt, [met('a'), short('b', atRisk)], {
      height: MIN_BLOCK_DAYS + 10,
      runStartDate: '2026-02-20',
    });
    expect(out).not.toHaveProperty('baseBlock');
  });

  it('miss #1 and miss #2 together → collapsed, with both transitions', () => {
    const out = evaluate(WINDOW.evaluateAt, [short('a'), short('b', atRisk)]);
    expect(out.periodStatus).toBe('collapsed');
    expect(sortedTransitions(out)).toEqual([
      { membershipId: 'a', from: 'active', to: 'at_risk' },
      { membershipId: 'b', from: 'at_risk', to: 'dormant', reason: 'consecutive_miss' },
    ]);
  });

  it('a higher consecutiveMisses count on an at_risk member still means dormant', () => {
    const out = evaluate(WINDOW.evaluateAt, [
      short('a', { state: 'at_risk', consecutiveMisses: 4 }),
    ]);
    expect(out.periodStatus).toBe('survived');
    expect(out.transitions).toEqual([
      { membershipId: 'a', from: 'at_risk', to: 'dormant', reason: 'consecutive_miss' },
    ]);
  });

  it('at_risk member who meets quota → active, on a survived period', () => {
    const out = evaluate(WINDOW.evaluateAt, [met('a'), met('b', atRisk)]);
    expect(out.periodStatus).toBe('survived');
    expect(out.transitions).toEqual([{ membershipId: 'b', from: 'at_risk', to: 'active' }]);
  });

  it('at_risk member who meets quota → active, even when someone else collapses the tower', () => {
    const out = evaluate(WINDOW.evaluateAt, [met('a', atRisk), short('b')]);
    expect(out.periodStatus).toBe('collapsed');
    expect(sortedTransitions(out)).toEqual([
      { membershipId: 'a', from: 'at_risk', to: 'active' },
      { membershipId: 'b', from: 'active', to: 'at_risk' },
    ]);
  });

  it('an active member who meets quota gets no transition', () => {
    const out = evaluate(WINDOW.evaluateAt, [met('a'), met('b')]);
    expect(out.transitions).toEqual([]);
  });

  it('an early survived (before wobbleAt) still emits the at_risk → active recovery', () => {
    // Survived is terminal regardless of now, so its transitions are too.
    const out = evaluate(BEFORE_WOBBLE, [met('a', atRisk)]);
    expect(out.periodStatus).toBe('survived');
    expect(out.transitions).toEqual([{ membershipId: 'a', from: 'at_risk', to: 'active' }]);
  });
});

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

describe('slack = daysRemaining - daysNeeded (daily: always 0 when short)', () => {
  it.each([...PHASES.open, ...PHASES.wobbling])('a short member at %s has slack 0', (now) => {
    const out = evaluate(now, [short('a')]);
    const a = out.perMember[0]!;
    expect(a.daysNeeded).toBe(1);
    expect(a.daysRemaining).toBe(1);
    expect(a.slack).toBe(0);
  });

  it.each(ALL_INSTANTS)('slack is daysRemaining - daysNeeded for every member at %s', (now) => {
    const out = evaluate(now, [
      met('a'),
      short('b'),
      short('c', { excused: true }),
      short('d', dormant),
    ]);
    for (const m of out.perMember) expect(m.slack).toBe(m.daysRemaining - m.daysNeeded);
  });

  it('a met member needs 0 days, and daysNeeded never goes negative', () => {
    const out = evaluate(BEFORE_WOBBLE, [met('a'), met('b', { qualifyingDays: 5 })]);
    expect(out.perMember.map((m) => m.daysNeeded)).toEqual([0, 0]);
    for (const m of out.perMember) expect(m.slack).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// baseBlock (2.6 floor) and nextPeriodStart
// ---------------------------------------------------------------------------

describe('baseBlock on collapse, only when the run meets MIN_BLOCK_DAYS', () => {
  it('height == MIN_BLOCK_DAYS → a block covering the run up to the previous period', () => {
    const runStartDate = addDays(PERIOD_START, -MIN_BLOCK_DAYS);
    const out = evaluate(WINDOW.evaluateAt, [short('a')], { height: MIN_BLOCK_DAYS, runStartDate });
    expect(out.periodStatus).toBe('collapsed');
    expect(out.baseBlock).toEqual({
      runStartDate,
      runEndDate: addDays(PERIOD_START, -1),
      blockHeight: MIN_BLOCK_DAYS,
    });
  });

  it('a long run carries its full height', () => {
    const height = MIN_BLOCK_DAYS + 7;
    const runStartDate = addDays(PERIOD_START, -height);
    const out = evaluate(WINDOW.evaluateAt, [short('a')], { height, runStartDate });
    expect(out.baseBlock).toEqual({
      runStartDate,
      runEndDate: '2026-03-09',
      blockHeight: height,
    });
  });

  it.each([
    ['MIN_BLOCK_DAYS - 1', MIN_BLOCK_DAYS - 1, addDays(PERIOD_START, -(MIN_BLOCK_DAYS - 1))],
    ['1', 1, addDays(PERIOD_START, -1)],
    ['0 (no run)', 0, null],
  ] as const)('height %s → collapsed with no baseBlock', (_label, height, runStartDate) => {
    const out = evaluate(WINDOW.evaluateAt, [short('a')], { height, runStartDate });
    expect(out.periodStatus).toBe('collapsed');
    expect(out).not.toHaveProperty('baseBlock');
  });

  it.each([
    ['open', BEFORE_WOBBLE, [short('a')]],
    ['wobbling', WINDOW.wobbleAt, [short('a')]],
    ['survived', WINDOW.evaluateAt, [met('a')]],
  ] as const)('%s never sets baseBlock, even on a long run', (status, now, members) => {
    const out = evaluate(now, [...members], { height: 50, runStartDate: '2026-01-19' });
    expect(out.periodStatus).toBe(status);
    expect(out).not.toHaveProperty('baseBlock');
  });
});

describe('nextPeriodStart', () => {
  it.each([
    ['survived early', BEFORE_WOBBLE, [met('a')]],
    ['survived at evaluateAt', WINDOW.evaluateAt, [met('a')]],
    ['collapsed', WINDOW.evaluateAt, [short('a')]],
    ['survived with no members', WINDOW.evaluateAt, []],
  ] as const)('%s → the day after periodEnd', (_label, now, members) => {
    expect(evaluate(now, [...members]).nextPeriodStart).toBe(NEXT_PERIOD_START);
  });

  it.each([
    ['open', BEFORE_WOBBLE],
    ['wobbling', WINDOW.wobbleAt],
  ] as const)('%s → unset', (status, now) => {
    const out = evaluate(now, [short('a')]);
    expect(out.periodStatus).toBe(status);
    expect(out).not.toHaveProperty('nextPeriodStart');
  });
});

// ---------------------------------------------------------------------------
// Determinism and purity
// ---------------------------------------------------------------------------

describe('determinism and purity', () => {
  const sample: EvaluationInput = inputOf(
    WINDOW.evaluateAt,
    [
      met('a', atRisk),
      short('b'),
      short('c', atRisk),
      short('d', { excused: true }),
      short('e', dormant),
    ],
    { height: MIN_BLOCK_DAYS + 1, runStartDate: addDays(PERIOD_START, -(MIN_BLOCK_DAYS + 1)) }
  );

  it('identical input → deeply equal output', () => {
    const first = evaluatePeriod(structuredClone(sample));
    const second = evaluatePeriod(structuredClone(sample));
    expect(second).toStrictEqual(first);
  });

  it('the same input object twice → deeply equal output (no hidden memory)', () => {
    const outs = [1, 2, 3].map(() => evaluatePeriod(sample));
    expect(outs[1]).toStrictEqual(outs[0]);
    expect(outs[2]).toStrictEqual(outs[0]);
  });

  it('an unrelated call in between does not change the result', () => {
    const first = evaluatePeriod(sample);
    evaluatePeriod(inputOf(BEFORE_WOBBLE, [short('z')]));
    expect(evaluatePeriod(sample)).toStrictEqual(first);
  });

  it('does not mutate its input', () => {
    const deepFreeze = <T>(o: T): T => {
      if (o && typeof o === 'object') {
        Object.values(o).forEach(deepFreeze);
        Object.freeze(o);
      }
      return o;
    };
    const input = deepFreeze(structuredClone(sample));
    const before = structuredClone(input);
    expect(() => evaluatePeriod(input)).not.toThrow();
    expect(input).toEqual(before);
  });

  it('does not depend on the system clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2001-01-01T00:00:00Z'));
    const first = evaluatePeriod(sample);
    vi.setSystemTime(new Date('2099-12-31T23:59:59Z'));
    expect(evaluatePeriod(sample)).toStrictEqual(first);
  });

  it('perMember has one outcome per input member, in input order', () => {
    const ids = sample.members.map((m) => m.membershipId);
    const reversed = { ...sample, members: [...sample.members].reverse() };
    expect(evaluatePeriod(sample).perMember.map((m) => m.membershipId)).toEqual(ids);
    expect(evaluatePeriod(reversed).perMember.map((m) => m.membershipId)).toEqual(
      [...ids].reverse()
    );
  });

  it('member order does not change the status or the set of transitions', () => {
    const a = evaluatePeriod(sample);
    const b = evaluatePeriod({ ...sample, members: [...sample.members].reverse() });
    expect(b.periodStatus).toBe(a.periodStatus);
    expect(sortedTransitions(b)).toEqual(sortedTransitions(a));
    expect(b.baseBlock).toEqual(a.baseBlock);
  });
});

// ---------------------------------------------------------------------------
// Monotonicity in now
//
// evaluate_at exists so a period cannot be un-collapsed. The pure function's
// share of that guarantee: for FIXED member state, advancing now never steps
// the status backwards along open < wobbling < {survived | collapsed}, a
// terminal status never changes, an early survived (everyone met) holds at
// every now, and every now at or after evaluateAt yields the same decision.
// (A survived can first appear at evaluateAt: the §6 ladder turns an at_risk
// member's second miss into dormancy instead of a collapse.)
// So a late or replayed tick (any now >= evaluateAt) reproduces exactly the
// collapse members were notified about. Refusing to re-evaluate a decided
// period with an EARLIER now is the database's half (evaluate_at), not this
// function's: given an earlier now, a pure function may legitimately say open.
// ---------------------------------------------------------------------------

/** survived and collapsed are both terminal: neither may follow the other. */
const TERMINAL = 2;
const RANK = { open: 0, wobbling: 1, survived: TERMINAL, collapsed: TERMINAL } as const;

type MemberSpec = { state: 'active' | 'at_risk' | 'dormant'; met: boolean; excused: boolean };

const MEMBER_SPECS: MemberSpec[] = (['active', 'at_risk', 'dormant'] as const).flatMap((state) =>
  [true, false].flatMap((isMet) => [true, false].map((excused) => ({ state, met: isMet, excused })))
);

const MISSES: Record<MemberSpec['state'], number> = { active: 0, at_risk: 1, dormant: 2 };

function toMember(spec: MemberSpec, i: number): MemberPeriodState {
  return member(`m${i}`, {
    state: spec.state satisfies MembershipState,
    qualifyingDays: spec.met ? 1 : 0,
    excused: spec.excused,
    consecutiveMisses: MISSES[spec.state],
  });
}

/** Every roster of 1..3 members drawn (with repetition) from MEMBER_SPECS. */
function* rosters(): Generator<MemberPeriodState[]> {
  const n = MEMBER_SPECS.length;
  for (let size = 1; size <= 3; size++) {
    const idx = new Array<number>(size).fill(0);
    for (;;) {
      yield idx.map((k, i) => toMember(MEMBER_SPECS[k]!, i));
      let p = size - 1;
      while (p >= 0 && idx[p] === n - 1) idx[p--] = 0;
      if (p < 0) break;
      idx[p]! += 1;
    }
  }
}

const describeRoster = (ms: MemberPeriodState[]) =>
  ms
    .map((m) => `${m.state}${m.qualifyingDays ? '+met' : '-short'}${m.excused ? '+excused' : ''}`)
    .join(', ');

/** Sorted, de-duplicated sweep grid for a window. */
function sweepGrid(w: EvaluationWindow): string[] {
  const p = phasesOf(w);
  const all = [
    shift(w.wobbleAt, -DAY),
    ...p.open,
    shift(w.wobbleAt, MS),
    ...p.wobbling,
    shift(w.deadlineAt, MS),
    ...p.terminal,
  ];
  return [...new Set(all.map((t) => new Date(t).toISOString()))].sort(
    (a, b) => Date.parse(a) - Date.parse(b)
  );
}

const RUN = { height: MIN_BLOCK_DAYS + 2, runStartDate: '2026-02-01' } as const;

const windows: [string, EvaluationWindow, Partial<TowerConfig>][] = [
  ['Edmonton daily', WINDOW, {}],
  (() => {
    // Spring-forward night in a zone that still observes DST: 02:30 does not
    // exist, the deadline resolves forward, and both leads floor at midnight.
    const t: Partial<TowerConfig> = { timezone: 'America/Toronto', deadlineTime: '02:30' };
    return ['Toronto spring-forward', computePeriodWindow({ ...TOWER, ...t }, '2026-03-08'), t];
  })(),
  (() => {
    // Fall-back night: 01:30 happens twice.
    const t: Partial<TowerConfig> = { timezone: 'America/Toronto', deadlineTime: '01:30' };
    return ['Toronto fall-back', computePeriodWindow({ ...TOWER, ...t }, '2026-11-01'), t];
  })(),
];

describe.each(windows)('monotonic in now: %s', (_label, window, towerOverrides) => {
  const grid = sweepGrid(window);
  const evaluateAtMs = Date.parse(window.evaluateAt);
  const tower = { ...towerOverrides, ...RUN };

  /**
   * For each roster, its output at every grid instant, in grid order. Lazy and
   * memoised: computed on first use inside a test, so a throwing evaluator
   * fails each test rather than the file's collection. The guards first check
   * the sweep covers what it claims, before the evaluator runs.
   */
  let cache: { members: MemberPeriodState[]; outs: EvaluationOutput[] }[] | undefined;
  const sweep = () => {
    if (cache) return cache;
    const all = [...rosters()];
    expect(all.length).toBe(12 + 12 ** 2 + 12 ** 3);
    expect(grid.length).toBeGreaterThanOrEqual(12);
    expect(Date.parse(window.wobbleAt)).toBeLessThan(evaluateAtMs);
    expect(grid.some((t) => Date.parse(t) < Date.parse(window.wobbleAt))).toBe(true);
    expect(grid.filter((t) => Date.parse(t) >= evaluateAtMs).length).toBeGreaterThanOrEqual(3);
    return (cache = all.map((members) => ({
      members,
      outs: grid.map((now) => evaluate(now, members, tower, window)),
    })));
  };

  it('status never steps backwards as now advances', () => {
    const offenders: string[] = [];
    for (const { members, outs } of sweep()) {
      const statuses = outs.map((o) => o.periodStatus);
      for (let i = 1; i < statuses.length; i++) {
        const prev = statuses[i - 1]!;
        const cur = statuses[i]!;
        // Terminal statuses are absorbing: once decided, the same decision.
        const stepsBack = RANK[cur] < RANK[prev] || (RANK[prev] === TERMINAL && cur !== prev);
        if (stepsBack) {
          offenders.push(`[${describeRoster(members)}] ${prev}@${grid[i - 1]} → ${cur}@${grid[i]}`);
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('survived before evaluateAt (everyone met) means survived at every now', () => {
    const offenders: string[] = [];
    for (const { members, outs } of sweep()) {
      const statuses = outs.map((o) => o.periodStatus);
      const early = statuses.some(
        (s, i) => s === 'survived' && Date.parse(grid[i]!) < evaluateAtMs
      );
      if (early && !statuses.every((s) => s === 'survived')) {
        offenders.push(`[${describeRoster(members)}] ${statuses.join(' ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('a survived reached only at evaluateAt is the ladder turning every miss into dormancy', () => {
    // [at_risk short] wobbles, then survives: miss #2 goes dormant instead of
    // collapsing. That is open/wobbling → terminal, so still monotone.
    const offenders: string[] = [];
    for (const { members, outs } of sweep()) {
      const firstSurvived = outs.findIndex((o) => o.periodStatus === 'survived');
      if (firstSurvived <= 0 || Date.parse(grid[firstSurvived]!) < evaluateAtMs) continue;
      const toDormant = new Set(
        outs[firstSurvived]!.transitions.filter((t) => t.to === 'dormant').map(
          (t) => t.membershipId
        )
      );
      const shortCounted = members.filter(
        (m) => (m.state === 'active' || m.state === 'at_risk') && !m.excused && m.qualifyingDays < 1
      );
      if (shortCounted.length === 0 || !shortCounted.every((m) => toDormant.has(m.membershipId))) {
        offenders.push(`[${describeRoster(members)}]`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('once collapsed, every later now is collapsed', () => {
    const offenders: string[] = [];
    for (const { members, outs } of sweep()) {
      const first = outs.findIndex((o) => o.periodStatus === 'collapsed');
      if (first === -1) continue;
      const later = outs.slice(first).map((o) => o.periodStatus);
      if (!later.every((s) => s === 'collapsed')) {
        offenders.push(`[${describeRoster(members)}] ${later.join(' ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('collapsed never appears before evaluateAt', () => {
    const offenders: string[] = [];
    for (const { members, outs } of sweep()) {
      outs.forEach((o, i) => {
        if (o.periodStatus === 'collapsed' && Date.parse(grid[i]!) < evaluateAtMs) {
          offenders.push(`[${describeRoster(members)}] collapsed@${grid[i]}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('walking now backwards from a collapse never yields survived, and never ranks above collapsed', () => {
    const offenders: string[] = [];
    for (const { members, outs } of sweep()) {
      for (let late = outs.length - 1; late >= 0; late--) {
        if (outs[late]!.periodStatus !== 'collapsed') continue;
        let ceiling = RANK.collapsed as number;
        for (let early = late - 1; early >= 0; early--) {
          const s = outs[early]!.periodStatus;
          if (s === 'survived' || RANK[s] > ceiling) {
            offenders.push(
              `[${describeRoster(members)}] collapsed@${grid[late]} but ${s}@${grid[early]}`
            );
            break;
          }
          ceiling = RANK[s];
        }
        break; // the latest collapse dominates every earlier pair
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every now >= evaluateAt yields the same decision (late and replayed ticks agree)', () => {
    const offenders: string[] = [];
    for (const { members, outs } of sweep()) {
      const terminal = outs.filter((_, i) => Date.parse(grid[i]!) >= evaluateAtMs);
      const decide = (o: EvaluationOutput) => ({
        periodStatus: o.periodStatus,
        transitions: sortedTransitions(o),
        baseBlock: o.baseBlock,
        nextPeriodStart: o.nextPeriodStart,
        standings: standings(o),
      });
      const first = decide(terminal[0]!);
      for (const o of terminal.slice(1)) {
        try {
          expect(decide(o)).toStrictEqual(first);
        } catch {
          offenders.push(`[${describeRoster(members)}]`);
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every now >= evaluateAt is terminal: never open or wobbling', () => {
    const offenders: string[] = [];
    for (const { members, outs } of sweep()) {
      outs.forEach((o, i) => {
        if (
          Date.parse(grid[i]!) >= evaluateAtMs &&
          (o.periodStatus === 'open' || o.periodStatus === 'wobbling')
        ) {
          offenders.push(`[${describeRoster(members)}] ${o.periodStatus}@${grid[i]}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('evaluator barrel', () => {
  it('exports a working evaluatePeriod', () => {
    const out = evaluator.evaluatePeriod(inputOf(BEFORE_WOBBLE, [met('a')]));
    expect(out.periodStatus).toBe('survived');
  });
});
