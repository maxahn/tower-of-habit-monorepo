import { describe, expect, it } from 'vitest';
import { DEFAULT_NUDGE_LEAD_MINUTES, DEFAULT_WOBBLE_LEAD_MINUTES } from '../schemas/index.js';
import type { LocalDate } from '../time/local-date.js';
import { computePeriodWindow } from '../time/period-window.js';
import { collapseLogFields } from './collapse-log.js';
import {
  evaluatePeriod,
  type EvaluationOutput,
  type MemberPeriodState,
  type TowerConfig,
} from './evaluate.js';
import * as evaluator from './index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOWER: TowerConfig = {
  periodUnit: 'day',
  timezone: 'America/Edmonton',
  deadlineTime: '22:00',
  graceWindowMinutes: 60,
  wobbleLeadMinutes: DEFAULT_WOBBLE_LEAD_MINUTES,
  nudgeLeadMinutes: DEFAULT_NUDGE_LEAD_MINUTES,
  weekResetDay: null,
  quota: 1,
  height: 5,
  currentStreak: 5,
  runStartDate: '2026-03-05',
};

const PERIOD_START: LocalDate = '2026-03-10';
const WINDOW = computePeriodWindow(TOWER, PERIOD_START);
const BEFORE_WOBBLE = new Date(Date.parse(WINDOW.wobbleAt) - 60 * 60_000).toISOString();

const member = (id: string, o: Partial<MemberPeriodState> = {}): MemberPeriodState => ({
  membershipId: id,
  state: 'active',
  qualifyingDays: 0,
  excused: false,
  consecutiveMisses: 0,
  ...o,
});
const met = (id: string, o: Partial<MemberPeriodState> = {}) =>
  member(id, { qualifyingDays: 1, ...o });
const short = member;

const evaluate = (now: string, members: MemberPeriodState[]): EvaluationOutput =>
  evaluatePeriod({ now, tower: TOWER, window: WINDOW, members });

const decided = (members: MemberPeriodState[]) => evaluate(WINDOW.evaluateAt, members);

// ---------------------------------------------------------------------------

describe('collapseLogFields', () => {
  it.each([
    ['open', BEFORE_WOBBLE, [short('a')]],
    ['wobbling', WINDOW.wobbleAt, [short('a')]],
    ['survived', WINDOW.evaluateAt, [met('a')]],
  ] as const)('%s → null', (status, now, members) => {
    const out = evaluate(now, [...members]);
    expect(out.periodStatus).toBe(status);
    expect(collapseLogFields(WINDOW, out)).toBeNull();
  });

  it('survived because every miss went dormant → null', () => {
    const out = decided([met('a'), short('b', { state: 'at_risk', consecutiveMisses: 1 })]);
    expect(out.periodStatus).toBe('survived');
    expect(collapseLogFields(WINDOW, out)).toBeNull();
  });

  it('a collapse → the first-miss member, with the period bounds', () => {
    const out = decided([met('a'), short('b'), met('c')]);
    expect(out.periodStatus).toBe('collapsed');
    expect(collapseLogFields(WINDOW, out)).toEqual({
      event: 'period_collapsed',
      periodStart: WINDOW.periodStart,
      periodEnd: WINDOW.periodEnd,
      missedBy: ['b'],
    });
  });

  it('several first misses → all of them, sorted', () => {
    const out = decided([short('m3'), met('m2'), short('m1')]);
    expect(collapseLogFields(WINDOW, out)?.missedBy).toEqual(['m1', 'm3']);
  });

  it('lists only members whose miss collapsed the tower', () => {
    const out = decided([
      short('collapser'),
      short('second-miss', { state: 'at_risk', consecutiveMisses: 1 }), // → dormant
      short('excused', { excused: true }),
      short('dormant', { state: 'dormant', consecutiveMisses: 2 }),
      short('removed', { state: 'removed' }),
      met('recovered', { state: 'at_risk', consecutiveMisses: 1 }),
      met('met'),
    ]);
    expect(out.periodStatus).toBe('collapsed');
    expect(collapseLogFields(WINDOW, out)?.missedBy).toEqual(['collapser']);
  });

  it('carries exactly its documented keys', () => {
    const fields = collapseLogFields(WINDOW, decided([short('a')]));
    expect(Object.keys(fields!).sort()).toEqual(['event', 'missedBy', 'periodEnd', 'periodStart']);
  });

  it('does not mutate its inputs', () => {
    const out = decided([short('b'), short('a')]);
    const before = structuredClone({ WINDOW, out });
    collapseLogFields(WINDOW, out);
    expect({ WINDOW, out }).toEqual(before);
  });

  it('is exported from the evaluator index', () => {
    expect(evaluator.collapseLogFields).toBe(collapseLogFields);
  });
});
