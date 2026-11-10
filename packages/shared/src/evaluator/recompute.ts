import type { LocalDate } from '../time/local-date.js';

/**
 * 1.12: derive a tower's evaluator-owned state from its period ledger alone.
 *
 * towers.height, towers.current_streak and the base_blocks boundaries are
 * denormalised and written by the evaluator in the same transaction as each
 * period evaluation (decision in 1.5). This recomputes all three from scratch,
 * IGNORING the stored values, so it serves as:
 *
 *   - the test oracle: every Phase 3 test asserts verifyTowerState(...).ok
 *     after evaluation, so a bookkeeping divergence is a red test, not a
 *     support ticket;
 *   - the repair tool: repairTower (@tower-of-habit/db) rewrites height and
 *     current_streak from this when a bug has shipped.
 *
 * WHAT IT TRUSTS. The stored period outcomes. Each outcome is the evaluator's
 * recorded decision; replaying it from entries would need the §6 ladder plus
 * membership history (joins, removals, voluntary dormancy) that is not stored,
 * which would make this a second, less faithful evaluator. So this catches bugs
 * in how outcomes are folded into height, streak and blocks. Whether each
 * outcome is right is the 3.x evaluator tests' job.
 *
 * The fold, in period_start order:
 *   - only 'evaluated' periods count; pending/evaluating ones are undecided;
 *   - survived: height + 1, and the period joins the current run;
 *   - collapsed: the run closes, leaving a block if height >= MIN_BLOCK_DAYS,
 *     and height resets to 0;
 *   - hibernated, freebie: neither moves. The run is paused, not closed (see
 *     block_height in base_blocks: a run may contain days that neither
 *     qualified nor collapsed). freebie is unused in v1;
 *   - current_streak == height under v1 daily rules.
 *
 * Pure: no database, no clock. Rosters and ordinals are out of scope: a roster
 * is a frozen snapshot, and ordinals are allocated by appendBaseBlock.
 */

/**
 * PROVISIONAL. The fewest qualifying days a run needs to leave a base block
 * (§5's "~3-day floor", owned by 3.9).
 */
export const MIN_BLOCK_DAYS = 3;

export type RecomputePeriodState = 'pending' | 'evaluating' | 'evaluated';
export type RecomputePeriodOutcome = 'survived' | 'collapsed' | 'hibernated' | 'freebie';

/** The columns of a tower_periods row the fold reads. Both db rows and plan records fit. */
export type RecomputePeriod = {
  periodStart: LocalDate;
  periodEnd: LocalDate;
  state: RecomputePeriodState;
  outcome: RecomputePeriodOutcome | null;
};

/** A base block's boundaries. Roster and ordinal are not compared. */
export type BlockBoundaries = {
  runStartDate: LocalDate;
  runEndDate: LocalDate;
  blockHeight: number;
};

export type StoredTowerState = {
  height: number;
  currentStreak: number;
  /** Oldest first: blocks[0] is ordinal 1. */
  blocks: readonly BlockBoundaries[];
};

export type RecomputedTowerState = {
  height: number;
  currentStreak: number;
  /** Oldest first. */
  blocks: BlockBoundaries[];
  /**
   * Ledger anomalies that are not a stored-value divergence but suggest an
   * evaluator bug, e.g. a period evaluated while an earlier one is undecided.
   */
  issues: string[];
};

export function recomputeTowerState(periods: readonly RecomputePeriod[]): RecomputedTowerState {
  const sorted = [...periods].sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  const blocks: BlockBoundaries[] = [];
  const issues: string[] = [];

  let height = 0;
  let runStart: LocalDate | null = null;
  let runEnd: LocalDate | null = null;
  let firstUndecided: LocalDate | null = null;

  for (const p of sorted) {
    if (p.state !== 'evaluated') {
      firstUndecided ??= p.periodStart;
      continue;
    }
    if (firstUndecided !== null) {
      issues.push(
        `period ${p.periodStart} is evaluated but the earlier period ${firstUndecided} is not`
      );
    }
    switch (p.outcome) {
      case 'survived':
        height += 1;
        runStart ??= p.periodStart;
        runEnd = p.periodEnd;
        break;
      case 'collapsed':
        if (runStart !== null && runEnd !== null && height >= MIN_BLOCK_DAYS) {
          blocks.push({ runStartDate: runStart, runEndDate: runEnd, blockHeight: height });
        }
        height = 0;
        runStart = null;
        runEnd = null;
        break;
      case 'hibernated':
      case 'freebie':
        break;
      case null:
        // tower_periods_outcome_iff_evaluated forbids this; a plan could still carry it.
        issues.push(`period ${p.periodStart} is evaluated but has no outcome`);
        break;
    }
  }

  return { height, currentStreak: height, blocks, issues };
}

export type TowerDivergence = {
  /** e.g. 'height', 'currentStreak', 'blocks.length', 'blocks[0].runEndDate'. */
  field: string;
  /** The recomputed value. */
  expected: number | string | null;
  /** The stored value. */
  actual: number | string | null;
};

/** Every field where stored disagrees with recomputed. Empty means they agree. */
export function diffTowerState(
  recomputed: RecomputedTowerState,
  stored: StoredTowerState
): TowerDivergence[] {
  const out: TowerDivergence[] = [];
  if (recomputed.height !== stored.height) {
    out.push({ field: 'height', expected: recomputed.height, actual: stored.height });
  }
  if (recomputed.currentStreak !== stored.currentStreak) {
    out.push({
      field: 'currentStreak',
      expected: recomputed.currentStreak,
      actual: stored.currentStreak,
    });
  }
  if (recomputed.blocks.length !== stored.blocks.length) {
    out.push({
      field: 'blocks.length',
      expected: recomputed.blocks.length,
      actual: stored.blocks.length,
    });
  }
  const n = Math.max(recomputed.blocks.length, stored.blocks.length);
  for (let i = 0; i < n; i++) {
    const r = recomputed.blocks[i];
    const s = stored.blocks[i];
    for (const key of ['runStartDate', 'runEndDate', 'blockHeight'] as const) {
      const expected = r?.[key] ?? null;
      const actual = s?.[key] ?? null;
      if (expected !== actual) out.push({ field: `blocks[${i}].${key}`, expected, actual });
    }
  }
  return out;
}

export type TowerVerification = {
  /** No divergences and no ledger issues. */
  ok: boolean;
  recomputed: RecomputedTowerState;
  divergences: TowerDivergence[];
};

/** recompute, then diff against what is stored. The oracle assertion in one call. */
export function verifyTowerState(
  periods: readonly RecomputePeriod[],
  stored: StoredTowerState
): TowerVerification {
  const recomputed = recomputeTowerState(periods);
  const divergences = diffTowerState(recomputed, stored);
  return {
    ok: divergences.length === 0 && recomputed.issues.length === 0,
    recomputed,
    divergences,
  };
}
