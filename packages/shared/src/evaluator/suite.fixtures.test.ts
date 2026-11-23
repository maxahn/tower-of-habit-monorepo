import { describe, expect, it } from 'vitest';
import {
  EVALUATOR_FIXTURES,
  runEvaluatorFixture,
  type EvaluatorFixture,
  type ExpectedTransition,
} from '../testing/evaluator-fixtures.js';
import { computePeriodWindow } from '../time/period-window.js';
import {
  evaluatePeriod,
  EvaluationInputError,
  type EvaluationInput,
  type MembershipTransition,
  type TowerConfig,
} from './evaluate.js';
import { MIN_BLOCK_DAYS } from './recompute.js';

/*
 * 2.7: the scenario matrix, end to end through the pure pipeline (window ->
 * dormancy events -> evaluatePeriod -> base block draft). Rows live in
 * src/testing/evaluator-fixtures.ts; this file only asserts them.
 */

const GROUPS: EvaluatorFixture['group'][] = [
  'clean survival',
  'single miss',
  'second miss',
  'excused absence',
  'all dormant',
  'one active member',
  'return mid-period',
  'backstop',
  'sub-minimum run',
];

/** Only the fields an ExpectedTransition names, sorted: order is not contract. */
function project(ts: MembershipTransition[], like: ExpectedTransition[]): ExpectedTransition[] {
  const withDate = like.some((t) => t.effectiveFrom !== undefined);
  return ts
    .map((t) => ({
      membershipId: t.membershipId,
      type: t.type,
      reason: t.reason,
      ...(withDate ? { effectiveFrom: t.effectiveFrom } : {}),
    }))
    .sort(byMember);
}

const byMember = (a: ExpectedTransition, b: ExpectedTransition) =>
  a.membershipId.localeCompare(b.membershipId) || a.type.localeCompare(b.type);

describe('fixture matrix covers every acceptance-criteria scenario', () => {
  it.each(GROUPS)('%s has at least one row', (group) => {
    expect(EVALUATOR_FIXTURES.some((f) => f.group === group)).toBe(true);
  });

  it('row names are unique', () => {
    const names = EVALUATOR_FIXTURES.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe.each(GROUPS)('%s', (group) => {
  const rows = EVALUATOR_FIXTURES.filter((f) => f.group === group);

  it.each(rows)('$name', (fixture) => {
    const r = runEvaluatorFixture(fixture);
    const x = fixture.expect;

    expect(r.output.periodStatus).toBe(x.periodStatus);

    const eventsExpected = x.eventTransitions ?? [];
    expect(project(r.eventTransitions, eventsExpected)).toEqual([...eventsExpected].sort(byMember));
    expect(project(r.output.transitions, x.transitions)).toEqual([...x.transitions].sort(byMember));

    if (x.standings) {
      expect(
        Object.fromEntries(r.output.perMember.map((o) => [o.membershipId, o.standing]))
      ).toEqual(x.standings);
    }
    if (x.consecutiveMisses) {
      expect(
        Object.fromEntries(r.output.perMember.map((o) => [o.membershipId, o.consecutiveMisses]))
      ).toEqual(x.consecutiveMisses);
    }

    expect(r.output.baseBlock ?? null).toEqual(x.baseBlock);
    expect(r.draft?.heightDays ?? null).toBe(x.draftHeightDays);
  });
});

describe('runner bookkeeping', () => {
  const fixture = EVALUATOR_FIXTURES.find((f) => f.group === 'single miss')!;

  it('evaluates the window computePeriodWindow gives for the row', () => {
    const r = runEvaluatorFixture(fixture);
    expect(r.window).toEqual(computePeriodWindow(fixture.tower, fixture.periodStart));
  });

  it.each([
    ['open', 'wobbleAt', -1],
    ['wobbling', 'evaluateAt', -1],
    ['decided', 'evaluateAt', 0],
  ] as const)('now "%s" is %s offset by %ims', (now, field, offset) => {
    const r = runEvaluatorFixture({ ...fixture, now });
    expect(Date.parse(r.now)).toBe(Date.parse(r.window[field]) + offset);
  });

  it('an explicit { at } instant is passed through', () => {
    const at = '2026-03-11T12:00:00.000Z';
    expect(runEvaluatorFixture({ ...fixture, now: { at } }).now).toBe(at);
  });

  it('the draft agrees with evaluatePeriod’s block boundaries', () => {
    const r = runEvaluatorFixture(fixture);
    expect(r.output.baseBlock).toBeDefined();
    expect(r.draft).not.toBeNull();
    expect(r.draft!.runStartDate).toBe(r.output.baseBlock!.runStartDate);
    expect(r.draft!.runEndDate).toBe(r.output.baseBlock!.runEndDate);
    expect(r.draft!.heightDays).toBe(r.output.baseBlock!.blockHeight);
    expect(r.draft!.roster.map((e) => e.user_id).sort()).toEqual(
      fixture.members.map((m) => m.membershipId).sort()
    );
  });

  it('does not mutate the fixture', () => {
    const copy = structuredClone(fixture);
    runEvaluatorFixture(fixture);
    expect(fixture).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// evaluatePeriod's remaining branches (input validation, the runStartDate
// guard), so 100% branch coverage is asserted behavior, not incidental.
// ---------------------------------------------------------------------------

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
const WINDOW = computePeriodWindow(TOWER, '2026-03-10');

const input = (o: Partial<EvaluationInput> = {}, tower: Partial<TowerConfig> = {}) => ({
  now: WINDOW.evaluateAt,
  window: WINDOW,
  members: [
    {
      membershipId: 'a',
      state: 'active' as const,
      qualifyingDays: 0,
      excused: false,
      consecutiveMisses: 0,
    },
  ],
  ...o,
  tower: { ...TOWER, ...tower },
});

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('evaluatePeriod input validation', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'quota %s → EvaluationInputError(tower.quota)',
    (quota) => {
      const e = thrown(() => evaluatePeriod(input({}, { quota })));
      expect(e).toBeInstanceOf(EvaluationInputError);
      expect(e).toMatchObject({ name: 'EvaluationInputError', field: 'tower.quota' });
    }
  );

  it.each([
    ['now', { now: 'not-a-date' }],
    ['window.wobbleAt', { window: { ...WINDOW, wobbleAt: '' } }],
    ['window.evaluateAt', { window: { ...WINDOW, evaluateAt: '2026-13-45T99:00Z' } }],
  ] as const)('unparseable %s → EvaluationInputError naming it', (field, o) => {
    const e = thrown(() => evaluatePeriod(input(o)));
    expect(e).toBeInstanceOf(EvaluationInputError);
    expect(e).toMatchObject({ field });
    expect((e as Error).message).toContain(field);
  });

  it('quota is checked before the instants', () => {
    const e = thrown(() => evaluatePeriod(input({ now: 'nope' }, { quota: 0 })));
    expect(e).toMatchObject({ field: 'tower.quota' });
  });

  it('quota 2: one qualifying day is still short', () => {
    const out = evaluatePeriod(
      input({ members: [{ ...input().members[0]!, qualifyingDays: 1 }] }, { quota: 2 })
    );
    expect(out.perMember[0]).toMatchObject({ standing: 'short', daysNeeded: 1 });
    expect(out.periodStatus).toBe('collapsed');
  });
});

describe('baseBlock guard: currentStreak alone is not enough', () => {
  it('currentStreak >= MIN_BLOCK_DAYS with runStartDate null → collapsed, no block', () => {
    const out = evaluatePeriod(
      input({}, { currentStreak: MIN_BLOCK_DAYS + 1, runStartDate: null })
    );
    expect(out.periodStatus).toBe('collapsed');
    expect(out.baseBlock).toBeUndefined();
  });
});
