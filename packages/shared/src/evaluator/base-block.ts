import type { BlockRoster } from '../schemas/index.js';
import type { LocalDate } from '../time/local-date.js';

/**
 * 2.6: on collapse, build the base block payload for the run that just closed:
 * its bounds, height, periods survived and the per-member roster.
 *
 * THE RUN, NOT THE COLLAPSE. runPeriods are the run's periods only, never the
 * period that collapsed it, and every member statistic is clipped to
 * [runStartDate, runEndDate] intersected with that member's membership span.
 * Records outside it (a log on the collapse day, a dormancy that starts after
 * it) are ignored.
 *
 * NO BLAME (§5). No field identifies who caused the collapse, and no
 * combination of fields makes it derivable from one block in isolation:
 *   - nothing about the collapsing period is an input, so nothing about it
 *     can be an output;
 *   - the draft and each roster member carry exactly the keys below; stray
 *     input fields are never passed through;
 *   - the roster is sorted by user_id, so the caller's input order (which
 *     might put the collapser first) cannot leak.
 * If support needs to know who missed, log it to the application log, never
 * to this payload or any user-visible table. A missedBy field "for debugging"
 * is exactly the permanent blame record the design rules out.
 *
 * ORDINAL is supplied by the caller and echoed verbatim: the evaluator doesn't
 * know how many blocks already exist. appendBaseBlock (@tower-of-habit/db)
 * still allocates the stored ordinal itself.
 *
 * MINIMUM is config (minBlockDays; MIN_BLOCK_DAYS is the usual value), not a
 * literal. A run with fewer height days yields null: no block. What happens to
 * the tower's height is the caller's concern, not this function's.
 *
 * Pure: no clock, no randomness, no module state; inputs are not mutated.
 */

export type RunPeriodOutcome = 'survived' | 'hibernated' | 'freebie';

/** One period of the collapsed run. Never the collapsing period itself. */
export type RunPeriod = {
  periodStart: LocalDate;
  /** Inclusive. */
  periodEnd: LocalDate;
  /** hibernated/freebie periods sit inside the run's bounds but add no height. */
  outcome: RunPeriodOutcome;
};

/** An inclusive date span; to null means still open. */
export type DateSpan = { from: LocalDate; to: LocalDate | null };

/** A habit-day that qualified (already decided by qualifies()). */
export type QualifyingDay = {
  localDate: LocalDate;
  /** 0 for binary and numeric habits (the base tier). */
  tierIndex: number;
};

/** Everything about one membership the roster entry is computed from. */
export type RunMember = {
  userId: string;
  /** Snapshotted as it stands now, i.e. at the end of the run. */
  displayName: string;
  /** First day of the membership. */
  joinedOn: LocalDate;
  /** Last day of the membership, inclusive; null while still a member. */
  leftOn: LocalDate | null;
  /** §6 dormancies, inclusive; to null while still dormant. */
  dormantSpans: readonly DateSpan[];
  /** May include days outside the run or the membership; those are ignored. */
  qualifyingDays: readonly QualifyingDay[];
};

export type BaseBlockInput = {
  /** The block's position in the stack, from the caller. Integer >= 1. */
  ordinal: number;
  /** Fewest height days a run needs to leave a block. Integer >= 1. */
  minBlockDays: number;
  /** In any order. */
  runPeriods: readonly RunPeriod[];
  /** Every membership the caller knows of; those not overlapping the run are dropped. */
  members: readonly RunMember[];
};

export type BaseBlockDraft = {
  ordinal: number;
  /** The earliest run period's start. */
  runStartDate: LocalDate;
  /** The latest run period's end, inclusive. */
  runEndDate: LocalDate;
  /** Qualifying days in the run: the days of its survived periods. */
  heightDays: number;
  periodsSurvived: number;
  /** Sorted by user_id; valid against blockRosterSchema. */
  roster: BlockRoster;
};

export class BaseBlockInputError extends Error {
  constructor(
    readonly field: string,
    readonly value: unknown
  ) {
    super(`Invalid base block input: ${field} = ${JSON.stringify(value)}`);
    this.name = 'BaseBlockInputError';
  }
}

export function buildBaseBlockDraft(input: BaseBlockInput): BaseBlockDraft | null {
  void input;
  throw new Error('buildBaseBlockDraft: not implemented');
}
