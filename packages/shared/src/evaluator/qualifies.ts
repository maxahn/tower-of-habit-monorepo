import type { HabitType } from '../schemas/index.js';

/**
 * 2.3: does a single entry reach base tier?
 *
 * Qualification is deliberately separate from recording. A non-qualifying
 * entry is still persisted (it feeds tier history, personal bests and numeric
 * totals); only this flag drives the tower. There is no notion of "already
 * logged today" here: that is the database's job via the partial unique index.
 *
 *   - binary:  any entry qualifies;
 *   - numeric: numericValue >= the base tier's (tierIndex 0) thresholdValue;
 *   - tiered:  tierReached >= 0.
 *
 * A numeric habit with no base threshold is a configuration error, thrown as
 * HabitConfigError rather than defaulting to true.
 *
 * Pure: no clock, no randomness, no module state.
 */

export type QualifyingTier = { tierIndex: number; thresholdValue: number | null };

export type HabitConfig = {
  type: HabitType;
  /** Matched by tierIndex, not array position. Tier 0 is the base tier. */
  tiers: readonly QualifyingTier[];
};

export type EntryDraft = {
  numericValue?: number | null;
  tierReached?: number | null;
};

export class HabitConfigError extends Error {
  constructor(
    readonly reason: 'missing_base_threshold',
    readonly habitType: HabitType
  ) {
    super(`Invalid ${habitType} habit config: ${reason}`);
    this.name = 'HabitConfigError';
  }
}

export function qualifies(habit: HabitConfig, entry: EntryDraft): boolean {
  switch (habit.type) {
    case 'binary':
      return true;
    case 'numeric': {
      // Config is checked before the entry, so a bad config throws whatever the value.
      const threshold = habit.tiers.find((t) => t.tierIndex === 0)?.thresholdValue;
      if (threshold == null) throw new HabitConfigError('missing_base_threshold', 'numeric');
      return entry.numericValue != null && entry.numericValue >= threshold;
    }
    case 'tiered':
      return entry.tierReached != null && entry.tierReached >= 0;
  }
}
