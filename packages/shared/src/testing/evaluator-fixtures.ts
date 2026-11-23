import type { DormancyReason } from '../schemas/index.js';
import { addDays, type LocalDate } from '../time/local-date.js';
import { computePeriodWindow, type PeriodSchedule } from '../time/period-window.js';
import {
  buildBaseBlockDraft,
  type BaseBlockDraft,
  type RunMember,
} from '../evaluator/base-block.js';
import {
  evaluatePeriod,
  type EvaluationOutput,
  type EvaluationStatus,
  type MemberPeriodState,
  type MemberStanding,
  type MembershipTransition,
  type TowerConfig,
} from '../evaluator/evaluate.js';
import { MIN_BLOCK_DAYS, type BlockBoundaries } from '../evaluator/recompute.js';
import {
  BACKSTOP_DAYS,
  stepMembership,
  type DormancyTrigger,
  type MembershipSnapshot,
  type MembershipTransitionType,
  type TransitionReason,
} from '../evaluator/dormancy.js';

/*
 * 2.7: the evaluator's scenario matrix as plain data, plus a runner that
 * pushes one row through the whole pure pipeline:
 *
 *   computePeriodWindow (2.2)
 *     -> stepMembership for the row's pre-evaluation events (2.5:
 *        qualifying_entry, day_elapsed: returns and the 14-day backstop)
 *     -> evaluatePeriod (2.4, which steps the §6 ladder itself)
 *     -> buildBaseBlockDraft (2.6) when the period collapsed a run
 *
 * No database, no clock, no network. Rows are exported so later suites (db,
 * 3.x) can replay the same matrix against persisted state.
 */

/** A member as the row describes it, before any event is applied. */
export type FixtureMember = MemberPeriodState & {
  /** Set iff state is 'dormant'. Default: consecutive_miss when dormant, else null. */
  dormancyReason?: DormancyReason | null;
  /** Backstop input. Default: the day before periodStart (never due). */
  lastQualifyingDate?: LocalDate | null;
  /** Default: the tower's runStartDate, else periodStart. */
  joinedOn?: LocalDate;
  /** Voluntary dormancy only: the first day back. */
  voluntaryReturnDate?: LocalDate | null;
};

/**
 * Applied in order, before evaluatePeriod, with the row's period as the open
 * one (openPeriodStart = periodStart).
 */
export type FixtureEvent =
  /** One member logged a qualifying entry dated localDate. */
  | { kind: 'qualifying_entry'; membershipId: string; localDate: LocalDate }
  /** asOf (tower-local) has ended; applied to every member. */
  | { kind: 'day_elapsed'; asOf: LocalDate };

/**
 * When to evaluate: a named point on the row's window, or an exact instant.
 *   open      wobbleAt - 1ms
 *   wobbling  evaluateAt - 1ms (inside the grace window)
 *   decided   evaluateAt
 */
export type FixtureNow = 'open' | 'wobbling' | 'decided' | { at: string };

/** A transition compared by what it means, not by every field. */
export type ExpectedTransition = {
  membershipId: string;
  type: MembershipTransitionType;
  reason: TransitionReason;
  effectiveFrom?: LocalDate;
};

export type FixtureExpectation = {
  periodStatus: EvaluationStatus;
  /** From the events, in order. Default: none. */
  eventTransitions?: ExpectedTransition[];
  /** From evaluatePeriod, compared as a set. */
  transitions: ExpectedTransition[];
  standings?: Record<string, MemberStanding>;
  /** perMember consecutiveMisses after the period. */
  consecutiveMisses?: Record<string, number>;
  /** evaluatePeriod's baseBlock; null means absent. */
  baseBlock: BlockBoundaries | null;
  /** buildBaseBlockDraft's heightDays; null means no draft. */
  draftHeightDays: number | null;
};

export type EvaluatorFixture = {
  name: string;
  /** Acceptance-criteria bucket, for grouping. */
  group:
    | 'clean survival'
    | 'single miss'
    | 'second miss'
    | 'excused absence'
    | 'all dormant'
    | 'one active member'
    | 'return mid-period'
    | 'backstop'
    | 'sub-minimum run';
  tower: TowerConfig;
  periodStart: LocalDate;
  now: FixtureNow;
  members: FixtureMember[];
  events?: FixtureEvent[];
  expect: FixtureExpectation;
};

export type FixtureResult = {
  window: PeriodSchedule;
  /** The ISO instant evaluatePeriod was given. */
  now: string;
  /** Transitions the events produced, in order. */
  eventTransitions: MembershipTransition[];
  /** The members as evaluatePeriod received them, after the events. */
  evaluatedMembers: MemberPeriodState[];
  output: EvaluationOutput;
  /**
   * buildBaseBlockDraft over the closed run (daily survived periods from
   * runStartDate for `height` days, every member qualifying each day, ordinal
   * 1, minBlockDays MIN_BLOCK_DAYS), when the period collapsed and the tower
   * had a run (height >= 1, runStartDate set). Otherwise null.
   */
  draft: BaseBlockDraft | null;
};

export function runEvaluatorFixture(fixture: EvaluatorFixture): FixtureResult {
  const { tower, periodStart } = fixture;
  const window = computePeriodWindow(tower, periodStart);
  const now = resolveNow(fixture.now, window);

  // Events step fresh snapshots; the fixture itself is never touched.
  const snapshots = fixture.members.map((m) => snapshotOf(m, tower, periodStart));
  const eventTransitions: MembershipTransition[] = [];
  for (const event of fixture.events ?? []) {
    if (
      event.kind === 'qualifying_entry' &&
      !snapshots.some((s) => s.membershipId === event.membershipId)
    ) {
      throw new Error(`runEvaluatorFixture: no member ${event.membershipId} for ${event.kind}`);
    }
    snapshots.forEach((s, i) => {
      if (event.kind === 'qualifying_entry' && s.membershipId !== event.membershipId) return;
      const { next, transition } = applyEvent(s, event, periodStart);
      snapshots[i] = next;
      if (transition) eventTransitions.push(transition);
    });
  }

  const evaluatedMembers: MemberPeriodState[] = fixture.members.map((m, i) => ({
    membershipId: m.membershipId,
    state: snapshots[i]!.state,
    qualifyingDays: m.qualifyingDays,
    excused: m.excused,
    consecutiveMisses: snapshots[i]!.consecutiveMisses,
  }));

  const output = evaluatePeriod({ now, tower, window, members: evaluatedMembers });

  const draft =
    output.periodStatus === 'collapsed' && tower.currentStreak >= 1 && tower.runStartDate !== null
      ? draftFor(tower.runStartDate, tower.currentStreak, snapshots)
      : null;

  return { window, now, eventTransitions, evaluatedMembers, output, draft };
}

function resolveNow(now: FixtureNow, w: PeriodSchedule): string {
  const shift = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
  switch (now) {
    case 'open':
      return shift(w.wobbleAt, -1);
    case 'wobbling':
      return shift(w.evaluateAt, -1);
    case 'decided':
      return w.evaluateAt;
    default:
      return now.at;
  }
}

function snapshotOf(
  m: FixtureMember,
  tower: TowerConfig,
  periodStart: LocalDate
): MembershipSnapshot {
  return {
    membershipId: m.membershipId,
    state: m.state,
    dormancyReason:
      m.dormancyReason !== undefined
        ? m.dormancyReason
        : m.state === 'dormant'
          ? 'consecutive_miss'
          : null,
    consecutiveMisses: m.consecutiveMisses,
    // Default: logged yesterday, so the backstop is never due unless a row says so.
    lastQualifyingDate:
      m.lastQualifyingDate !== undefined ? m.lastQualifyingDate : addDays(periodStart, -1),
    joinedOn: m.joinedOn ?? tower.runStartDate ?? periodStart,
    voluntaryReturnDate: m.voluntaryReturnDate ?? null,
  };
}

/** One event against one member; the period under evaluation is the open one. */
function applyEvent(
  s: MembershipSnapshot,
  event: FixtureEvent,
  openPeriodStart: LocalDate
): { next: MembershipSnapshot; transition: MembershipTransition | null } {
  const trigger: DormancyTrigger =
    event.kind === 'qualifying_entry'
      ? { kind: 'qualifying_entry', localDate: event.localDate, openPeriodStart }
      : { kind: 'day_elapsed', asOf: event.asOf, openPeriodStart };
  const step = stepMembership(s, trigger);
  const next: MembershipSnapshot = { ...s, consecutiveMisses: step.consecutiveMisses };
  if (
    event.kind === 'qualifying_entry' &&
    (next.lastQualifyingDate === null || next.lastQualifyingDate < event.localDate)
  ) {
    next.lastQualifyingDate = event.localDate;
  }
  const t = step.transition;
  if (t) {
    next.state = t.to;
    next.dormancyReason = t.dormancyReason ?? null;
    if (t.to !== 'dormant') next.voluntaryReturnDate = null;
  }
  return { next, transition: t };
}

/**
 * The closed run as 2.6 sees it: `height` survived daily periods from
 * runStartDate, every member (as of before the events) qualifying each day.
 */
function draftFor(
  runStartDate: LocalDate,
  height: number,
  members: readonly MembershipSnapshot[]
): BaseBlockDraft | null {
  const days = Array.from({ length: height }, (_, i) => addDays(runStartDate, i));
  return buildBaseBlockDraft({
    ordinal: 1,
    minBlockDays: MIN_BLOCK_DAYS,
    runPeriods: days.map((d) => ({ periodStart: d, periodEnd: d, outcome: 'survived' })),
    members: members.map((s): RunMember => ({
      userId: s.membershipId,
      displayName: s.membershipId,
      joinedOn: s.joinedOn,
      leftOn: null,
      dormantSpans: [],
      qualifyingDays: days.map((localDate) => ({ localDate, tierIndex: 0 })),
    })),
  });
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

const PERIOD_START: LocalDate = '2026-03-10';
const NEXT: LocalDate = addDays(PERIOD_START, 1);

const TOWER: TowerConfig = {
  periodUnit: 'day',
  timezone: 'America/Edmonton',
  deadlineTime: '22:00',
  graceWindowMinutes: 60,
  wobbleLeadMinutes: 120,
  nudgeLeadMinutes: 240,
  weekResetDay: null,
  quota: 1,
  height: 0,
  currentStreak: 0,
  runStartDate: null,
};

/** A tower whose current run is `height` survived days ending yesterday. */
const withRun = (height: number): TowerConfig => ({
  ...TOWER,
  height,
  currentStreak: height,
  runStartDate: height > 0 ? addDays(PERIOD_START, -height) : null,
});

const blockFor = (height: number): BlockBoundaries => ({
  runStartDate: addDays(PERIOD_START, -height),
  runEndDate: addDays(PERIOD_START, -1),
  blockHeight: height,
});

const m = (id: string, o: Partial<FixtureMember> = {}): FixtureMember => ({
  membershipId: id,
  state: 'active',
  qualifyingDays: 1,
  excused: false,
  consecutiveMisses: 0,
  ...o,
});
const short = (id: string, o: Partial<FixtureMember> = {}) => m(id, { qualifyingDays: 0, ...o });
const atRisk = { state: 'at_risk', consecutiveMisses: 1 } as const;
const dormant = {
  state: 'dormant',
  consecutiveMisses: 2,
  dormancyReason: 'consecutive_miss',
} as const;

const toAtRisk = (id: string): ExpectedTransition => ({
  membershipId: id,
  type: 'at_risk',
  reason: 'missed_period',
  effectiveFrom: NEXT,
});
const toDormant = (id: string): ExpectedTransition => ({
  membershipId: id,
  type: 'dormant',
  reason: 'consecutive_miss',
  effectiveFrom: NEXT,
});

const H = MIN_BLOCK_DAYS + 4;

export const EVALUATOR_FIXTURES: readonly EvaluatorFixture[] = [
  // --- clean survival -------------------------------------------------------
  {
    name: 'everyone met → survived at evaluateAt, no transitions, no block',
    group: 'clean survival',
    tower: withRun(H),
    periodStart: PERIOD_START,
    now: 'decided',
    members: [m('a'), m('b'), m('c')],
    expect: {
      periodStatus: 'survived',
      transitions: [],
      standings: { a: 'met', b: 'met', c: 'met' },
      consecutiveMisses: { a: 0, b: 0, c: 0 },
      baseBlock: null,
      draftHeightDays: null,
    },
  },
  {
    name: 'everyone met before wobbleAt → survived early',
    group: 'clean survival',
    tower: withRun(H),
    periodStart: PERIOD_START,
    now: 'open',
    members: [m('a'), m('b')],
    expect: { periodStatus: 'survived', transitions: [], baseBlock: null, draftHeightDays: null },
  },

  // --- single miss → collapse ----------------------------------------------
  {
    name: 'one active member short at evaluateAt → collapsed, at_risk, block for the run',
    group: 'single miss',
    tower: withRun(H),
    periodStart: PERIOD_START,
    now: 'decided',
    members: [m('a'), short('b')],
    expect: {
      periodStatus: 'collapsed',
      transitions: [toAtRisk('b')],
      standings: { a: 'met', b: 'short' },
      consecutiveMisses: { a: 0, b: 1 },
      baseBlock: blockFor(H),
      draftHeightDays: H,
    },
  },
  {
    name: 'same member short inside the grace window → wobbling, not yet collapsed',
    group: 'single miss',
    tower: withRun(H),
    periodStart: PERIOD_START,
    now: 'wobbling',
    members: [m('a'), short('b')],
    expect: {
      periodStatus: 'wobbling',
      transitions: [],
      consecutiveMisses: { a: 0, b: 0 },
      baseBlock: null,
      draftHeightDays: null,
    },
  },

  // --- second miss → dormancy ----------------------------------------------
  {
    name: 'at_risk member short again → dormant (consecutive_miss) INSTEAD of collapsing',
    group: 'second miss',
    tower: withRun(H),
    periodStart: PERIOD_START,
    now: 'decided',
    members: [m('a'), short('b', atRisk)],
    expect: {
      periodStatus: 'survived',
      transitions: [toDormant('b')],
      consecutiveMisses: { a: 0, b: 2 },
      baseBlock: null,
      draftHeightDays: null,
    },
  },
  {
    name: 'second miss alongside a first miss → collapsed, both transitions',
    group: 'second miss',
    tower: withRun(H),
    periodStart: PERIOD_START,
    now: 'decided',
    members: [short('a'), short('b', atRisk)],
    expect: {
      periodStatus: 'collapsed',
      transitions: [toAtRisk('a'), toDormant('b')],
      baseBlock: blockFor(H),
      draftHeightDays: H,
    },
  },

  // --- excused absence -----------------------------------------------------
  {
    name: 'excused member logged nothing → survived, counter untouched',
    group: 'excused absence',
    tower: withRun(H),
    periodStart: PERIOD_START,
    now: 'decided',
    members: [m('a'), short('b', { excused: true })],
    expect: {
      periodStatus: 'survived',
      transitions: [],
      standings: { a: 'met', b: 'excused' },
      consecutiveMisses: { a: 0, b: 0 },
      baseBlock: null,
      draftHeightDays: null,
    },
  },
  {
    name: 'excused at_risk member is not ladder-stepped',
    group: 'excused absence',
    tower: withRun(H),
    periodStart: PERIOD_START,
    now: 'decided',
    members: [m('a'), short('b', { ...atRisk, excused: true })],
    expect: {
      periodStatus: 'survived',
      transitions: [],
      consecutiveMisses: { a: 0, b: 1 },
      baseBlock: null,
      draftHeightDays: null,
    },
  },

  // --- all dormant ---------------------------------------------------------
  {
    name: 'every member dormant → survived, no transitions (hibernation is the caller’s)',
    group: 'all dormant',
    tower: withRun(H),
    periodStart: PERIOD_START,
    now: 'decided',
    members: [short('a', dormant), short('b', dormant), short('c', dormant)],
    expect: {
      periodStatus: 'survived',
      transitions: [],
      standings: { a: 'excluded', b: 'excluded', c: 'excluded' },
      consecutiveMisses: { a: 2, b: 2, c: 2 },
      baseBlock: null,
      draftHeightDays: null,
    },
  },

  // --- one active member ---------------------------------------------------
  {
    name: 'the only live member met → survived',
    group: 'one active member',
    tower: withRun(H),
    periodStart: PERIOD_START,
    now: 'decided',
    members: [m('a'), short('b', dormant), short('c', dormant)],
    expect: {
      periodStatus: 'survived',
      transitions: [],
      standings: { a: 'met', b: 'excluded', c: 'excluded' },
      baseBlock: null,
      draftHeightDays: null,
    },
  },
  {
    name: 'the only live member short → collapsed, at_risk',
    group: 'one active member',
    tower: withRun(H),
    periodStart: PERIOD_START,
    now: 'decided',
    members: [short('a'), short('b', dormant)],
    expect: {
      periodStatus: 'collapsed',
      transitions: [toAtRisk('a')],
      baseBlock: blockFor(H),
      draftHeightDays: H,
    },
  },

  // --- return mid-period ---------------------------------------------------
  {
    name: 'auto-dormant member logs mid-period → returned from periodStart, counted as met',
    group: 'return mid-period',
    tower: withRun(H),
    periodStart: PERIOD_START,
    now: 'decided',
    members: [m('a'), m('b', dormant)],
    events: [{ kind: 'qualifying_entry', membershipId: 'b', localDate: PERIOD_START }],
    expect: {
      periodStatus: 'survived',
      eventTransitions: [
        { membershipId: 'b', type: 'returned', reason: 'logged', effectiveFrom: PERIOD_START },
      ],
      transitions: [],
      standings: { a: 'met', b: 'met' },
      consecutiveMisses: { a: 0, b: 0 },
      baseBlock: null,
      draftHeightDays: null,
    },
  },
  {
    name: 'voluntary-dormant member logs → stays dormant, excluded',
    group: 'return mid-period',
    tower: withRun(H),
    periodStart: PERIOD_START,
    now: 'decided',
    members: [
      m('a'),
      m('b', {
        state: 'dormant',
        dormancyReason: 'voluntary',
        voluntaryReturnDate: addDays(PERIOD_START, 5),
      }),
    ],
    events: [{ kind: 'qualifying_entry', membershipId: 'b', localDate: PERIOD_START }],
    expect: {
      periodStatus: 'survived',
      eventTransitions: [],
      transitions: [],
      standings: { a: 'met', b: 'excluded' },
      baseBlock: null,
      draftHeightDays: null,
    },
  },
  {
    name: 'voluntary return date reached → returned, then short like anyone else',
    group: 'return mid-period',
    tower: withRun(H),
    periodStart: PERIOD_START,
    now: 'decided',
    members: [
      m('a'),
      short('b', {
        state: 'dormant',
        dormancyReason: 'voluntary',
        voluntaryReturnDate: PERIOD_START,
      }),
    ],
    events: [{ kind: 'day_elapsed', asOf: addDays(PERIOD_START, -1) }],
    expect: {
      periodStatus: 'collapsed',
      eventTransitions: [
        {
          membershipId: 'b',
          type: 'returned',
          reason: 'return_date_reached',
          effectiveFrom: PERIOD_START,
        },
      ],
      transitions: [toAtRisk('b')],
      standings: { a: 'met', b: 'short' },
      baseBlock: blockFor(H),
      draftHeightDays: H,
    },
  },

  // --- 14-day backstop -----------------------------------------------------
  // The tower was hibernating, so no periods were evaluated to move the ladder;
  // only the backstop catches the silent member.
  {
    name: `${BACKSTOP_DAYS} days without a qualifying entry → dormant (backstop), then excluded`,
    group: 'backstop',
    tower: withRun(H),
    periodStart: PERIOD_START,
    now: 'decided',
    members: [
      m('a'),
      short('b', { lastQualifyingDate: addDays(PERIOD_START, -1 - BACKSTOP_DAYS) }),
    ],
    events: [{ kind: 'day_elapsed', asOf: addDays(PERIOD_START, -1) }],
    expect: {
      periodStatus: 'survived',
      eventTransitions: [
        { membershipId: 'b', type: 'dormant', reason: 'backstop', effectiveFrom: PERIOD_START },
      ],
      transitions: [],
      standings: { a: 'met', b: 'excluded' },
      consecutiveMisses: { a: 0, b: 0 },
      baseBlock: null,
      draftHeightDays: null,
    },
  },
  {
    name: `${BACKSTOP_DAYS - 1} days → no backstop yet; the short member collapses the tower`,
    group: 'backstop',
    tower: withRun(H),
    periodStart: PERIOD_START,
    now: 'decided',
    members: [m('a'), short('b', { lastQualifyingDate: addDays(PERIOD_START, -BACKSTOP_DAYS) })],
    events: [{ kind: 'day_elapsed', asOf: addDays(PERIOD_START, -1) }],
    expect: {
      periodStatus: 'collapsed',
      eventTransitions: [],
      transitions: [toAtRisk('b')],
      baseBlock: blockFor(H),
      draftHeightDays: H,
    },
  },
  {
    name: 'backstop never fires on a dormant member',
    group: 'backstop',
    tower: withRun(H),
    periodStart: PERIOD_START,
    now: 'decided',
    members: [m('a'), short('b', { ...dormant, lastQualifyingDate: '2025-01-01' })],
    events: [{ kind: 'day_elapsed', asOf: addDays(PERIOD_START, -1) }],
    expect: {
      periodStatus: 'survived',
      eventTransitions: [],
      transitions: [],
      baseBlock: null,
      draftHeightDays: null,
    },
  },

  // --- sub-minimum run on collapse ------------------------------------------
  ...Array.from({ length: MIN_BLOCK_DAYS }, (_, height): EvaluatorFixture => ({
    name: `collapse with a run of ${height} (< MIN_BLOCK_DAYS) → no block, no draft`,
    group: 'sub-minimum run',
    tower: withRun(height),
    periodStart: PERIOD_START,
    now: 'decided',
    members: [m('a'), short('b')],
    expect: {
      periodStatus: 'collapsed',
      transitions: [toAtRisk('b')],
      baseBlock: null,
      draftHeightDays: null,
    },
  })),
  {
    name: 'collapse with a run of exactly MIN_BLOCK_DAYS → a block',
    group: 'sub-minimum run',
    tower: withRun(MIN_BLOCK_DAYS),
    periodStart: PERIOD_START,
    now: 'decided',
    members: [m('a'), short('b')],
    expect: {
      periodStatus: 'collapsed',
      transitions: [toAtRisk('b')],
      baseBlock: blockFor(MIN_BLOCK_DAYS),
      draftHeightDays: MIN_BLOCK_DAYS,
    },
  },
];
