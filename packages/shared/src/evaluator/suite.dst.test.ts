import { describe, expect, it } from 'vitest';
import { ZONE_WINDOW_ROWS, zoneRowSchedule, type ZoneWindowRow } from '../testing/dst-fixtures.js';
import { runEvaluatorFixture } from '../testing/evaluator-fixtures.js';
import { addDays } from '../time/local-date.js';
import { computePeriodWindow } from '../time/period-window.js';
import {
  evaluatePeriod,
  type EvaluationStatus,
  type MemberPeriodState,
  type TowerConfig,
} from './evaluate.js';
import { MIN_BLOCK_DAYS } from './recompute.js';

/*
 * 2.7: 2.2's zone table (DST gaps and overlaps, half- and 45-minute offsets,
 * no-DST controls) driven through a full evaluation rather than window
 * computation alone. 2.2 proves the instants; this proves the evaluator reads
 * them as instants on the transition night: wobbling through the whole grace
 * window, collapsed at exactly evaluateAt, and the run's block ending on the
 * previous civil day.
 */

const MS = 1;
const HEIGHT = MIN_BLOCK_DAYS + 2;

const shift = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

function towerFor(row: ZoneWindowRow): TowerConfig {
  return {
    ...zoneRowSchedule(row),
    quota: 1,
    height: HEIGHT,
    runStartDate: addDays(row.start, -HEIGHT),
  };
}

const member = (id: string, qualifyingDays: number): MemberPeriodState => ({
  membershipId: id,
  state: 'active',
  qualifyingDays,
  excused: false,
  consecutiveMisses: 0,
});
const SHORT = [member('a', 1), member('b', 0)];
const MET = [member('a', 1), member('b', 1)];

const DST_ROWS = ZONE_WINDOW_ROWS.filter((r) => r.dst);

it('the table still has DST rows to drive (gap and overlap, both zones)', () => {
  expect(DST_ROWS.length).toBeGreaterThanOrEqual(6);
  expect(DST_ROWS.some((r) => r.tz === 'Pacific/Chatham')).toBe(true);
  expect(DST_ROWS.some((r) => r.tz === 'America/Edmonton')).toBe(true);
});

describe.each(ZONE_WINDOW_ROWS)('$name', (row) => {
  const tower = towerFor(row);
  const window = computePeriodWindow(tower, row.start);
  const run = (now: string, members = SHORT) => evaluatePeriod({ now, tower, window, members });

  it('window is the 2.2 row (sanity: the same instants feed the evaluator)', () => {
    expect(window).toEqual({ periodStart: row.start, periodEnd: row.start, ...row.expected });
  });

  const timeline: [string, () => string, EvaluationStatus][] = [
    ['wobbleAt - 1ms', () => shift(window.wobbleAt, -MS), 'open'],
    ['wobbleAt', () => window.wobbleAt, 'wobbling'],
    ['deadlineAt - 1ms', () => shift(window.deadlineAt, -MS), 'wobbling'],
    ['deadlineAt', () => window.deadlineAt, 'wobbling'],
    ['evaluateAt - 1ms', () => shift(window.evaluateAt, -MS), 'wobbling'],
    ['evaluateAt', () => window.evaluateAt, 'collapsed'],
    ['evaluateAt + 1h', () => shift(window.evaluateAt, 3_600_000), 'collapsed'],
  ];

  it.each(timeline)('short member at %s → %s', (_label, at, status) => {
    expect(run(at()).periodStatus).toBe(status);
  });

  it.each(timeline)('everyone met at %s → survived', (_label, at) => {
    expect(run(at(), MET).periodStatus).toBe('survived');
  });

  it('daysRemaining is 1 until evaluateAt and 0 from it (tower-local today clamp)', () => {
    for (const at of [
      shift(window.wobbleAt, -MS),
      window.deadlineAt,
      shift(window.evaluateAt, -MS),
    ]) {
      expect(run(at).perMember.every((o) => o.daysRemaining === 1)).toBe(true);
    }
    expect(run(window.evaluateAt).perMember.every((o) => o.daysRemaining === 0)).toBe(true);
  });

  it('collapse: nextPeriodStart is the next civil day; the block ends the day before', () => {
    const out = run(window.evaluateAt);
    expect(out.nextPeriodStart).toBe(addDays(row.start, 1));
    expect(out.baseBlock).toEqual({
      runStartDate: addDays(row.start, -HEIGHT),
      runEndDate: addDays(row.start, -1),
      blockHeight: HEIGHT,
    });
    expect(out.transitions.map((t) => [t.membershipId, t.type, t.effectiveFrom])).toEqual([
      ['b', 'at_risk', addDays(row.start, 1)],
    ]);
  });

  it('through the full pipeline: draft heightDays matches the block', () => {
    const r = runEvaluatorFixture({
      name: row.name,
      group: 'single miss',
      tower,
      periodStart: row.start,
      now: 'decided',
      members: SHORT,
      expect: {
        periodStatus: 'collapsed',
        transitions: [],
        baseBlock: null,
        draftHeightDays: HEIGHT,
      },
    });
    expect(r.window).toEqual(window);
    expect(r.now).toBe(window.evaluateAt);
    expect(r.output.periodStatus).toBe('collapsed');
    expect(r.draft).toMatchObject({
      runStartDate: addDays(row.start, -HEIGHT),
      runEndDate: addDays(row.start, -1),
      heightDays: HEIGHT,
    });
  });
});
