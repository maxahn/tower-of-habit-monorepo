import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NUDGE_LEAD_MINUTES, DEFAULT_WOBBLE_LEAD_MINUTES } from '../schemas/index.js';
import type { MembershipState } from '../schemas/index.js';
import { addDays, type LocalDate } from '../time/local-date.js';
import { computePeriodWindow } from '../time/period-window.js';
import {
  backstopDue,
  BACKSTOP_DAYS,
  stepMembership,
  type DormancyStep,
  type DormancyTrigger,
  type MembershipSnapshot,
  type MembershipTransition,
} from './dormancy.js';
import { evaluatePeriod, type MemberStanding, type TowerConfig } from './evaluate.js';
import * as evaluator from './index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const JOINED: LocalDate = '2026-01-05';

// A daily period, and the weekly one (Mon..Sun) that contains it.
const DAY: LocalDate = '2026-03-10'; // Tuesday
const NEXT_DAY: LocalDate = '2026-03-11';
const WEEK_START: LocalDate = '2026-03-09';
const WEEK_END: LocalDate = '2026-03-15';
const NEXT_WEEK: LocalDate = '2026-03-16';

const snapshot = (id: string, o: Partial<MembershipSnapshot> = {}): MembershipSnapshot => ({
  membershipId: id,
  state: 'active',
  dormancyReason: null,
  consecutiveMisses: 0,
  lastQualifyingDate: null,
  joinedOn: JOINED,
  voluntaryReturnDate: null,
  ...o,
});

const RETURN_DATE: LocalDate = '2026-03-12'; // Thursday, mid-week

const atRisk = { state: 'at_risk', consecutiveMisses: 1 } as const;
const dormantMiss = {
  state: 'dormant',
  dormancyReason: 'consecutive_miss',
  consecutiveMisses: 2,
} as const;
const dormantBackstop = {
  state: 'dormant',
  dormancyReason: 'backstop',
  consecutiveMisses: 0,
} as const;
const dormantVoluntary = {
  state: 'dormant',
  dormancyReason: 'voluntary',
  consecutiveMisses: 0,
  voluntaryReturnDate: RETURN_DATE,
} as const;
const removed = { state: 'removed', consecutiveMisses: 0 } as const;

const period = (
  standing: MemberStanding,
  periodStart: LocalDate = DAY,
  periodEnd: LocalDate = periodStart
): DormancyTrigger => ({ kind: 'period_evaluated', periodStart, periodEnd, standing });
const entry = (localDate: LocalDate, openPeriodStart: LocalDate = localDate): DormancyTrigger => ({
  kind: 'qualifying_entry',
  localDate,
  openPeriodStart,
});
const dayElapsed = (
  asOf: LocalDate,
  openPeriodStart: LocalDate = addDays(asOf, 1)
): DormancyTrigger => ({
  kind: 'day_elapsed',
  asOf,
  openPeriodStart,
});

const noop = (consecutiveMisses: number): DormancyStep => ({
  transition: null,
  consecutiveMisses,
  collapses: false,
});

/** Feed a step back in, as the caller would after persisting it. */
function applyStep(m: MembershipSnapshot, step: DormancyStep): MembershipSnapshot {
  const t = step.transition;
  return {
    ...m,
    consecutiveMisses: step.consecutiveMisses,
    ...(t ? { state: t.to, dormancyReason: t.dormancyReason ?? null } : {}),
  };
}

/** What evaluatePeriod would hand the state machine for a member who logged nothing. */
const absentStanding = (m: MembershipSnapshot): MemberStanding =>
  m.state === 'active' || m.state === 'at_risk' ? 'short' : 'excluded';

// Restated from @tower-of-habit/db's ALLOWED_MEMBERSHIP_TRANSITIONS (firewall).
const ALLOWED: Record<MembershipState, readonly MembershipState[]> = {
  active: ['at_risk', 'dormant', 'removed'],
  at_risk: ['active', 'dormant', 'removed'],
  dormant: ['active', 'removed'],
  removed: [],
};

const REASONS_BY_TYPE: Record<MembershipTransition['type'], readonly string[]> = {
  at_risk: ['missed_period'],
  recovered: ['met_quota'],
  dormant: ['consecutive_miss', 'backstop'],
  returned: ['logged', 'return_date_reached'],
};

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// The transition table
// ---------------------------------------------------------------------------

type Row = [name: string, m: MembershipSnapshot, t: DormancyTrigger, expected: DormancyStep];

const TABLE: Row[] = [
  ['active + met → active, no transition', snapshot('a'), period('met'), noop(0)],
  [
    'active (misses 0) + short → at_risk, collapses',
    snapshot('a'),
    period('short'),
    {
      transition: {
        membershipId: 'a',
        type: 'at_risk',
        from: 'active',
        to: 'at_risk',
        reason: 'missed_period',
        effectiveFrom: NEXT_DAY,
      },
      consecutiveMisses: 1,
      collapses: true,
    },
  ],
  [
    'at_risk + met → active (recovered)',
    snapshot('a', atRisk),
    period('met'),
    {
      transition: {
        membershipId: 'a',
        type: 'recovered',
        from: 'at_risk',
        to: 'active',
        reason: 'met_quota',
        effectiveFrom: NEXT_DAY,
      },
      consecutiveMisses: 0,
      collapses: false,
    },
  ],
  [
    'at_risk + short again → dormant (consecutive_miss), no collapse',
    snapshot('a', atRisk),
    period('short'),
    {
      transition: {
        membershipId: 'a',
        type: 'dormant',
        from: 'at_risk',
        to: 'dormant',
        dormancyReason: 'consecutive_miss',
        reason: 'consecutive_miss',
        effectiveFrom: NEXT_DAY,
      },
      consecutiveMisses: 2,
      collapses: false,
    },
  ],
  [
    'active with misses >= 1 + short → dormant, no collapse (as in 2.4)',
    snapshot('a', { consecutiveMisses: 1 }),
    period('short'),
    {
      transition: {
        membershipId: 'a',
        type: 'dormant',
        from: 'active',
        to: 'dormant',
        dormancyReason: 'consecutive_miss',
        reason: 'consecutive_miss',
        effectiveFrom: NEXT_DAY,
      },
      consecutiveMisses: 2,
      collapses: false,
    },
  ],
  [
    'weekly period: effectiveFrom is the day after periodEnd',
    snapshot('a'),
    period('short', WEEK_START, WEEK_END),
    {
      transition: {
        membershipId: 'a',
        type: 'at_risk',
        from: 'active',
        to: 'at_risk',
        reason: 'missed_period',
        effectiveFrom: NEXT_WEEK,
      },
      consecutiveMisses: 1,
      collapses: true,
    },
  ],
  ['active + excused → no change', snapshot('a'), period('excused'), noop(0)],
  [
    'at_risk + excused → no change, counter kept',
    snapshot('a', atRisk),
    period('excused'),
    noop(1),
  ],
  ['active + excluded → no change', snapshot('a'), period('excluded'), noop(0)],
  [
    'live + 14 days without a qualifying entry → dormant (backstop)',
    snapshot('a', { lastQualifyingDate: '2026-02-24' }),
    dayElapsed('2026-03-10'),
    {
      transition: {
        membershipId: 'a',
        type: 'dormant',
        from: 'active',
        to: 'dormant',
        dormancyReason: 'backstop',
        reason: 'backstop',
        effectiveFrom: '2026-03-11',
      },
      consecutiveMisses: 0,
      collapses: false,
    },
  ],
  [
    'dormant_auto + logs once → active (returned)',
    snapshot('a', dormantMiss),
    entry('2026-03-11', WEEK_START),
    {
      transition: {
        membershipId: 'a',
        type: 'returned',
        from: 'dormant',
        to: 'active',
        reason: 'logged',
        effectiveFrom: WEEK_START,
      },
      consecutiveMisses: 0,
      collapses: false,
    },
  ],
  [
    'dormant_voluntary + return date reached → active (returned)',
    snapshot('a', dormantVoluntary),
    dayElapsed(addDays(RETURN_DATE, -1), WEEK_START),
    {
      transition: {
        membershipId: 'a',
        type: 'returned',
        from: 'dormant',
        to: 'active',
        reason: 'return_date_reached',
        effectiveFrom: WEEK_START,
      },
      consecutiveMisses: 0,
      collapses: false,
    },
  ],
  ['dormant_auto + period short → no change', snapshot('a', dormantMiss), period('short'), noop(2)],
  [
    'dormant_auto + period excluded → no change',
    snapshot('a', dormantMiss),
    period('excluded'),
    noop(2),
  ],
  ['removed + period short → no change', snapshot('a', removed), period('short'), noop(0)],
  ['removed + entry → no change', snapshot('a', removed), entry(DAY), noop(0)],
  [
    'removed + 30 empty days → no change',
    snapshot('a', { ...removed, lastQualifyingDate: '2026-02-01' }),
    dayElapsed('2026-03-03'),
    noop(0),
  ],
];

describe('transition table', () => {
  it.each(TABLE)('%s', (_name, m, t, expected) => {
    expect(stepMembership(m, t)).toStrictEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// At most one collapse per absence
// ---------------------------------------------------------------------------

describe('at most one collapse per absent member per absence', () => {
  it.each([1, 2, 3, 5, 10])('daily: %i consecutive misses → one collapse', (n) => {
    let m = snapshot('a', { lastQualifyingDate: addDays(DAY, -1) });
    const steps: DormancyStep[] = [];
    for (let i = 0; i < n; i++) {
      const day = addDays(DAY, i);
      const step = stepMembership(m, period(absentStanding(m), day));
      steps.push(step);
      m = applyStep(m, step);
    }
    expect(steps.filter((s) => s.collapses)).toHaveLength(1);
    expect(steps[0]!.collapses).toBe(true);
    expect(steps.map((s) => s.transition?.type ?? null)).toEqual(
      [...['at_risk', 'dormant'], ...Array(8).fill(null)].slice(0, n)
    );
  });

  it('the second consecutive miss goes dormant instead of collapsing', () => {
    const first = stepMembership(snapshot('a'), period('short', DAY));
    const second = stepMembership(applyStep(snapshot('a'), first), period('short', NEXT_DAY));
    expect(first.collapses).toBe(true);
    expect(second.collapses).toBe(false);
    expect(second.transition?.to).toBe('dormant');
  });

  it('a recovery in between starts a new absence, which may collapse once more', () => {
    let m = snapshot('a');
    const outcomes: MemberStanding[] = ['short', 'met', 'short', 'short', 'short'];
    const collapses = outcomes.map((standing, i) => {
      const step = stepMembership(m, period(standing, addDays(DAY, i)));
      m = applyStep(m, step);
      return step.collapses;
    });
    expect(collapses).toEqual([true, false, true, false, false]);
  });

  // Weekly cadence with the daily backstop sweep interleaved: whichever fires
  // first, the absence collapses the tower exactly once. Both orders of the
  // period evaluation and the sweep on a period's last day are covered.
  describe.each([0, 1, 2, 3, 4, 5, 6])('weekly, last entry on week day %i', (offset) => {
    it.each(['period first', 'sweep first'] as const)('%s', (order) => {
      const lastEntry = addDays(WEEK_START, offset);
      let m = snapshot('a', { lastQualifyingDate: lastEntry });
      let collapses = 0;
      // Week 0 (WEEK_START..) was met by lastEntry; absent from then on.
      for (let d = 0; d < 10 * 7; d++) {
        const day = addDays(WEEK_START, d);
        const weekStart = addDays(WEEK_START, d - (d % 7));
        const isWeekEnd = d % 7 === 6;
        const runPeriod = () => {
          if (!isWeekEnd) return;
          const standing: MemberStanding = d < 7 ? 'met' : absentStanding(m);
          const step = stepMembership(m, period(standing, weekStart, day));
          if (step.collapses) collapses++;
          m = applyStep(m, step);
        };
        const runSweep = () => {
          const step = stepMembership(m, dayElapsed(day, addDays(day, 1)));
          if (step.collapses) collapses++;
          m = applyStep(m, step);
        };
        if (order === 'period first') {
          runPeriod();
          runSweep();
        } else {
          runSweep();
          runPeriod();
        }
      }
      expect(collapses).toBe(1);
      expect(m.state).toBe('dormant');
    });
  });
});

// ---------------------------------------------------------------------------
// 14-day backstop
// ---------------------------------------------------------------------------

describe('14-day backstop', () => {
  const LAST: LocalDate = '2026-03-01';

  it('BACKSTOP_DAYS is 14', () => {
    expect(BACKSTOP_DAYS).toBe(14);
  });

  it.each([
    [0, false],
    [1, false],
    [13, false],
    [14, true],
    [15, true],
    [60, true],
  ])('%i days after the last qualifying entry → due: %s', (days, due) => {
    const m = snapshot('a', { lastQualifyingDate: LAST });
    expect(backstopDue(m, addDays(LAST, days))).toBe(due);
    const step = stepMembership(m, dayElapsed(addDays(LAST, days)));
    expect(step.transition?.reason ?? null).toBe(due ? 'backstop' : null);
  });

  it('fires from at_risk too, keeping the counter', () => {
    const step = stepMembership(
      snapshot('a', { ...atRisk, lastQualifyingDate: LAST }),
      dayElapsed(addDays(LAST, 14))
    );
    expect(step.transition).toMatchObject({
      from: 'at_risk',
      to: 'dormant',
      dormancyReason: 'backstop',
    });
    expect(step.consecutiveMisses).toBe(1);
    expect(step.collapses).toBe(false);
  });

  it('is independent of cadence: daily and weekly open periods give the same transition', () => {
    const m = snapshot('a', { lastQualifyingDate: LAST });
    const asOf = addDays(LAST, 14); // 2026-03-15, a Sunday
    const daily = stepMembership(m, dayElapsed(asOf, addDays(asOf, 1)));
    const weekly = stepMembership(m, dayElapsed(asOf, '2026-03-09'));
    expect(daily.transition).not.toBeNull();
    expect(weekly).toStrictEqual(daily);
    expect(daily.transition!.effectiveFrom).toBe(addDays(asOf, 1));
  });

  it('fires mid-period, not only at a period boundary', () => {
    // asOf is a Wednesday inside the open week.
    const m = snapshot('a', { lastQualifyingDate: '2026-02-25' });
    const step = stepMembership(m, dayElapsed('2026-03-11', WEEK_START));
    expect(step.transition?.reason).toBe('backstop');
    expect(step.transition?.effectiveFrom).toBe('2026-03-12');
  });

  it('counts from the most recent qualifying entry, not from joining', () => {
    const m = snapshot('a', { joinedOn: '2025-01-01', lastQualifyingDate: '2026-03-05' });
    expect(backstopDue(m, '2026-03-10')).toBe(false);
    expect(stepMembership(m, dayElapsed('2026-03-10')).transition).toBeNull();
  });

  it('with no qualifying entry yet, counts from joinedOn', () => {
    const m = snapshot('a', { joinedOn: LAST, lastQualifyingDate: null });
    expect(backstopDue(m, addDays(LAST, 13))).toBe(false);
    expect(backstopDue(m, addDays(LAST, 14))).toBe(true);
  });

  it.each([
    ['dormant (consecutive_miss)', dormantMiss],
    ['dormant (backstop)', dormantBackstop],
    ['dormant (voluntary)', { ...dormantVoluntary, voluntaryReturnDate: '2026-06-01' }],
    ['removed', removed],
  ] as const)('never fires for %s', (_name, o) => {
    const m = snapshot('a', { ...o, lastQualifyingDate: '2026-01-10' });
    expect(backstopDue(m, '2026-03-10')).toBe(false);
    expect(stepMembership(m, dayElapsed('2026-03-10'))).toStrictEqual(noop(o.consecutiveMisses));
  });

  it('a live member inside the window: day_elapsed is a no-op that keeps the counter', () => {
    const m = snapshot('a', { ...atRisk, lastQualifyingDate: '2026-03-05' });
    expect(stepMembership(m, dayElapsed('2026-03-10'))).toStrictEqual(noop(1));
  });
});

// ---------------------------------------------------------------------------
// Returning from dormant_auto
// ---------------------------------------------------------------------------

describe('returning from dormant_auto', () => {
  it.each([
    ['consecutive_miss', 2],
    ['consecutive_miss', 5],
    ['backstop', 0],
    ['backstop', 1],
  ] as const)('dormant (%s, misses %i) + one log → active with misses 0', (reason, misses) => {
    const m = snapshot('a', {
      state: 'dormant',
      dormancyReason: reason,
      consecutiveMisses: misses,
    });
    const step = stepMembership(m, entry(DAY));
    expect(step.transition).toMatchObject({
      type: 'returned',
      from: 'dormant',
      to: 'active',
      reason: 'logged',
    });
    expect(step.consecutiveMisses).toBe(0);
    expect(step.collapses).toBe(false);
  });

  it('no dormancyReason on a return', () => {
    const step = stepMembership(snapshot('a', dormantMiss), entry(DAY));
    expect(step.transition).not.toHaveProperty('dormancyReason');
  });

  it('a day passing alone does not return a dormant_auto member', () => {
    expect(stepMembership(snapshot('a', dormantMiss), dayElapsed(DAY))).toStrictEqual(noop(2));
  });

  it.each([
    ['active', {}],
    ['at_risk', atRisk],
  ] as const)('a log from a %s member is not a transition and keeps the counter', (_s, o) => {
    const m = snapshot('a', o);
    expect(stepMembership(m, entry(DAY))).toStrictEqual(noop(m.consecutiveMisses));
  });
});

// ---------------------------------------------------------------------------
// Mid-period returns
// ---------------------------------------------------------------------------

describe('a return mid-period is effective from the open period start', () => {
  it('dormant_auto logs on a Wednesday → effectiveFrom is the week start', () => {
    const step = stepMembership(snapshot('a', dormantMiss), entry('2026-03-11', WEEK_START));
    expect(step.transition?.effectiveFrom).toBe(WEEK_START);
  });

  it('voluntary return date on a Thursday → effectiveFrom is the week start', () => {
    const step = stepMembership(
      snapshot('a', dormantVoluntary),
      dayElapsed(addDays(RETURN_DATE, -1), WEEK_START)
    );
    expect(step.transition?.effectiveFrom).toBe(WEEK_START);
  });

  it('daily: the open period is the day itself', () => {
    const step = stepMembership(snapshot('a', dormantMiss), entry(DAY, DAY));
    expect(step.transition?.effectiveFrom).toBe(DAY);
  });

  it('the period’s entries from before the return count when it is evaluated', () => {
    // Integration with 2.4: a voluntary member logged on DAY while away and
    // returns on DAY. The caller counts entries from effectiveFrom, so the
    // returned member meets quota and the tower survives.
    const tower: TowerConfig = {
      periodUnit: 'day',
      timezone: 'America/Edmonton',
      deadlineTime: '22:00',
      graceWindowMinutes: 60,
      wobbleLeadMinutes: DEFAULT_WOBBLE_LEAD_MINUTES,
      nudgeLeadMinutes: DEFAULT_NUDGE_LEAD_MINUTES,
      weekResetDay: null,
      quota: 1,
      height: 0,
      currentStreak: 0,
      runStartDate: null,
    };
    const window = computePeriodWindow(tower, DAY);
    const entriesOn: LocalDate[] = [DAY];

    const m = snapshot('a', { ...dormantVoluntary, voluntaryReturnDate: DAY });
    const step = stepMembership(m, dayElapsed(addDays(DAY, -1), DAY));
    const back = applyStep(m, step);
    const from = step.transition!.effectiveFrom;
    const qualifyingDays = entriesOn.filter((d) => d >= from && d <= window.periodEnd).length;

    const out = evaluatePeriod({
      now: window.evaluateAt,
      tower,
      window,
      members: [
        {
          membershipId: 'a',
          state: back.state,
          qualifyingDays,
          excused: false,
          consecutiveMisses: back.consecutiveMisses,
        },
      ],
    });
    expect(back.state).toBe('active');
    expect(qualifyingDays).toBe(1);
    expect(out.periodStatus).toBe('survived');
  });
});

// ---------------------------------------------------------------------------
// Voluntary dormancy
// ---------------------------------------------------------------------------

describe('voluntary dormancy is never auto-escalated and expires on its own date', () => {
  const m = snapshot('a', { ...dormantVoluntary, lastQualifyingDate: '2026-01-15' });

  it.each(['short', 'excluded', 'met', 'excused'] as const)('period %s → no change', (standing) => {
    expect(stepMembership(m, period(standing))).toStrictEqual(noop(0));
  });

  it('long past the backstop window but before the return date → no change', () => {
    expect(stepMembership(m, dayElapsed(addDays(RETURN_DATE, -2)))).toStrictEqual(noop(0));
  });

  it('a log while away does not end voluntary dormancy', () => {
    expect(stepMembership(m, entry('2026-03-10', WEEK_START))).toStrictEqual(noop(0));
  });

  it('the day before the return date has elapsed → active', () => {
    const step = stepMembership(m, dayElapsed(addDays(RETURN_DATE, -1), WEEK_START));
    expect(step.transition).toMatchObject({
      type: 'returned',
      reason: 'return_date_reached',
      to: 'active',
    });
    expect(step.consecutiveMisses).toBe(0);
  });

  it('a late sweep past the return date still returns the member', () => {
    const step = stepMembership(m, dayElapsed(addDays(RETURN_DATE, 5), '2026-03-16'));
    expect(step.transition?.reason).toBe('return_date_reached');
    expect(step.transition?.effectiveFrom).toBe('2026-03-16');
  });

  it('no return date → stays dormant indefinitely', () => {
    const open = snapshot('a', { ...dormantVoluntary, voluntaryReturnDate: null });
    expect(stepMembership(open, dayElapsed('2027-01-01'))).toStrictEqual(noop(0));
  });

  it('a voluntary return date on an auto-dormant member is ignored', () => {
    const auto = snapshot('a', { ...dormantMiss, voluntaryReturnDate: RETURN_DATE });
    expect(stepMembership(auto, dayElapsed(RETURN_DATE))).toStrictEqual(noop(2));
  });
});

// ---------------------------------------------------------------------------
// Transition shape and legality, over everything the table produces
// ---------------------------------------------------------------------------

describe('every transition is a well-formed membership_events row', () => {
  const allTransitions = (): [MembershipSnapshot, MembershipTransition][] =>
    TABLE.flatMap(([, m, t]) => {
      const tr = stepMembership(m, t).transition;
      return tr ? [[m, tr] as [MembershipSnapshot, MembershipTransition]] : [];
    });

  it('carries type, effectiveFrom and reason', () => {
    const all = allTransitions();
    expect(all.length).toBeGreaterThanOrEqual(7);
    for (const [m, t] of all) {
      expect(t.membershipId).toBe(m.membershipId);
      expect(t.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(REASONS_BY_TYPE[t.type]).toContain(t.reason);
    }
  });

  it('dormancyReason is present iff the transition goes dormant, and matches the reason', () => {
    for (const [, t] of allTransitions()) {
      expect('dormancyReason' in t).toBe(t.to === 'dormant');
      if (t.to === 'dormant') expect(t.dormancyReason).toBe(t.reason);
    }
  });

  it('from is the input state, and from → to is an allowed transition', () => {
    for (const [m, t] of allTransitions()) {
      expect(t.from).toBe(m.state);
      expect(ALLOWED[t.from]).toContain(t.to);
    }
  });

  it('only a period miss collapses, and only into at_risk', () => {
    for (const [, m, t] of TABLE) {
      const step = stepMembership(m, t);
      if (step.collapses) expect(step.transition?.type).toBe('at_risk');
    }
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe('determinism and purity', () => {
  const m = snapshot('a', { ...atRisk, lastQualifyingDate: '2026-02-20' });
  const t = dayElapsed('2026-03-10', WEEK_START);

  it('identical input → deeply equal output', () => {
    expect(stepMembership(structuredClone(m), structuredClone(t))).toStrictEqual(
      stepMembership(structuredClone(m), structuredClone(t))
    );
  });

  it('does not mutate its input', () => {
    const fm = Object.freeze(structuredClone(m));
    const ft = Object.freeze(structuredClone(t));
    expect(() => stepMembership(fm, ft)).not.toThrow();
    expect(fm).toEqual(m);
    expect(ft).toEqual(t);
  });

  it('does not depend on the system clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2001-01-01T00:00:00Z'));
    const first = stepMembership(m, t);
    const due = backstopDue(m, '2026-03-10');
    vi.setSystemTime(new Date('2099-12-31T23:59:59Z'));
    expect(stepMembership(m, t)).toStrictEqual(first);
    expect(backstopDue(m, '2026-03-10')).toBe(due);
  });
});

describe('evaluator barrel', () => {
  it('exports the dormancy state machine', () => {
    expect(evaluator.BACKSTOP_DAYS).toBe(14);
    expect(evaluator.stepMembership(snapshot('a'), period('met'))).toStrictEqual(noop(0));
    expect(evaluator.backstopDue(snapshot('a', { lastQualifyingDate: DAY }), DAY)).toBe(false);
  });
});
