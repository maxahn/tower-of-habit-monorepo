import type { z } from 'zod';
import type { LocalDate } from '../../time/local-date.js';
import type { FreebieSource, PeriodOutcome, PeriodStatus } from '../enums.js';
import type { BlockRoster } from '../roster.js';
import { notImplemented } from '../todo.js';

/*
 * Read-only tower history: periods and base blocks. Mirrors TowerPeriod
 * (towers/periods/schema.ts) and BaseBlock (towers/blocks/schema.ts).
 *
 * TODO(2.1): implement, then replace the hand-written types with z.infer.
 * Rules (tests: ./periods-blocks.test.ts):
 *   period
 *   - state: periodStatusSchema; outcome: periodOutcomeSchema | null;
 *     freebieSource: freebieSourceSchema | null;
 *   - periodStart / periodEnd: YYYY-MM-DD; timestamps ISO-8601 with offset;
 *   - attempts: integer >= 0;
 *   - tower_periods_outcome_iff_evaluated: outcome non-null exactly when
 *     state === 'evaluated';
 *   - tower_periods_freebie_fields_iff_freebie: freebieSource non-null exactly
 *     when outcome === 'freebie';
 *   block
 *   - ordinal, blockHeight: integers >= 1; run dates YYYY-MM-DD;
 *   - roster: REUSE blockRosterSchema from ../roster.ts (strict, non-empty).
 */

export type TowerPeriodResponse = {
  id: string;
  towerId: string;
  periodStart: LocalDate;
  periodEnd: LocalDate;
  deadlineAt: string;
  evaluateAt: string;
  state: PeriodStatus;
  outcome: PeriodOutcome | null;
  evaluatedAt: string | null;
  claimedAt: string | null;
  attempts: number;
  freebieSource: FreebieSource | null;
  freebieGrantedBy: string | null;
  createdAt: string;
};

export type BaseBlockResponse = {
  id: string;
  towerId: string;
  ordinal: number;
  runStartDate: LocalDate;
  runEndDate: LocalDate;
  blockHeight: number;
  roster: BlockRoster;
  createdAt: string;
};

export const towerPeriodResponseSchema = notImplemented<z.ZodType<TowerPeriodResponse>>(
  'towerPeriodResponseSchema'
);
export const baseBlockResponseSchema =
  notImplemented<z.ZodType<BaseBlockResponse>>('baseBlockResponseSchema');
