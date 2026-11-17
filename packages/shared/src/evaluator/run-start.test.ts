import { describe, expect, it } from 'vitest';
import { currentRunStart, type RecomputePeriod } from './recompute.js';

/*
 * 2.17/2.19: the evaluator input needs the first period of the current run
 * (null when height is 0). Derived from the period ledger the same way
 * recomputeTowerState folds it, so the two never disagree.
 */

const p = (
  periodStart: string,
  outcome: RecomputePeriod['outcome'],
  state: RecomputePeriod['state'] = 'evaluated'
): RecomputePeriod => ({ periodStart, periodEnd: periodStart, state, outcome });

describe('currentRunStart', () => {
  it('is null with no evaluated periods', () => {
    expect(currentRunStart([])).toBeNull();
    expect(currentRunStart([p('2026-11-16', null, 'pending')])).toBeNull();
  });

  it('is the first survived period of the current run', () => {
    expect(
      currentRunStart([
        p('2026-11-14', 'survived'),
        p('2026-11-15', 'survived'),
        p('2026-11-16', null, 'pending'),
      ])
    ).toBe('2026-11-14');
  });

  it('resets on a collapse', () => {
    expect(
      currentRunStart([
        p('2026-11-13', 'survived'),
        p('2026-11-14', 'collapsed'),
        p('2026-11-15', 'survived'),
      ])
    ).toBe('2026-11-15');
    expect(currentRunStart([p('2026-11-13', 'survived'), p('2026-11-14', 'collapsed')])).toBeNull();
  });

  it('is unmoved by hibernated and freebie periods, and ignores order', () => {
    expect(
      currentRunStart([
        p('2026-11-15', 'hibernated'),
        p('2026-11-14', 'survived'),
        p('2026-11-16', 'freebie'),
      ])
    ).toBe('2026-11-14');
  });
});
