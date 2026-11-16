import type { BlockRoster, BlockRosterMember } from '../schemas/index.js';
import { daysBetween, type LocalDate } from '../time/local-date.js';

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
  const { ordinal, minBlockDays } = input;
  // Validated first, so a bad ordinal throws even for a run too short for a block.
  if (!isPositiveInt(ordinal)) throw new BaseBlockInputError('ordinal', ordinal);
  if (!isPositiveInt(minBlockDays)) throw new BaseBlockInputError('minBlockDays', minBlockDays);

  const survived = input.runPeriods.filter((p) => p.outcome === 'survived');
  const heightDays = survived.reduce((n, p) => n + spanDays(p.periodStart, p.periodEnd), 0);
  // Also covers an empty run: heightDays 0 is below any valid minimum.
  if (heightDays < minBlockDays) return null;

  // Not sorted in place: the input may be frozen, and is never mutated.
  let runStartDate = input.runPeriods[0]!.periodStart;
  let runEndDate = input.runPeriods[0]!.periodEnd;
  for (const p of input.runPeriods) {
    if (p.periodStart < runStartDate) runStartDate = p.periodStart;
    if (p.periodEnd > runEndDate) runEndDate = p.periodEnd;
  }

  const roster = input.members
    .flatMap((m) => rosterEntry(m, runStartDate, runEndDate, survived))
    // Code-unit order, not localeCompare: the order must not depend on locale.
    // By user_id rather than input order, so the caller's order cannot leak.
    .sort((a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0));
  // blockRosterSchema is non-empty: a block nobody built is a caller bug.
  if (roster.length === 0) throw new BaseBlockInputError('members', input.members.length);

  // Keys spelled out, nothing spread from the input (§5).
  return {
    ordinal,
    runStartDate,
    runEndDate,
    heightDays,
    periodsSurvived: survived.length,
    roster,
  };
}

const isPositiveInt = (n: number) => Number.isInteger(n) && n >= 1;

/** Days in an inclusive span. */
const spanDays = (from: LocalDate, to: LocalDate) => daysBetween(from, to) + 1;

/** Whether two inclusive spans share a day; a null end is open. */
const overlaps = (aFrom: LocalDate, aTo: LocalDate | null, bFrom: LocalDate, bTo: LocalDate) =>
  aFrom <= bTo && (aTo === null || aTo >= bFrom);

/**
 * The member's roster entry, counted over the run intersected with their
 * membership; none if they held no membership during the run.
 */
function rosterEntry(
  m: RunMember,
  runStart: LocalDate,
  runEnd: LocalDate,
  survived: readonly RunPeriod[]
): BlockRosterMember[] {
  const from = m.joinedOn > runStart ? m.joinedOn : runStart;
  const to = m.leftOn !== null && m.leftOn < runEnd ? m.leftOn : runEnd;
  if (from > to) return [];

  // Several qualifying records on one date are one day, at their highest tier.
  const tierByDate = new Map<LocalDate, number>();
  for (const q of m.qualifyingDays) {
    if (q.localDate < from || q.localDate > to) continue;
    tierByDate.set(q.localDate, Math.max(tierByDate.get(q.localDate) ?? 0, q.tierIndex));
  }

  // Exactly the schema's keys, nothing spread from the input (§5).
  return [
    {
      user_id: m.userId,
      display_name: m.displayName,
      qualifying_days: tierByDate.size,
      total_days: spanDays(from, to),
      highest_tier: Math.max(0, ...tierByDate.values()),
      was_dormant: m.dormantSpans.some((s) => overlaps(s.from, s.to, from, to)),
      periods_present: survived.filter((p) => overlaps(p.periodStart, p.periodEnd, from, to))
        .length,
    },
  ];
}
