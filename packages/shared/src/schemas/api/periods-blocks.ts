import { z } from 'zod';
import { freebieSourceSchema, periodOutcomeSchema, periodStatusSchema } from '../enums.js';
import { blockRosterSchema } from '../roster.js';
import { localDate, nonNegativeInt, positiveInt, timestamp, uuid } from './common.js';

/*
 * Read-only tower history: periods and base blocks. Mirrors TowerPeriod
 * (towers/periods/schema.ts) and BaseBlock (towers/blocks/schema.ts).
 */

export const towerPeriodResponseSchema = z
  .object({
    id: uuid,
    towerId: uuid,
    periodStart: localDate,
    periodEnd: localDate,
    deadlineAt: timestamp,
    evaluateAt: timestamp,
    state: periodStatusSchema,
    outcome: periodOutcomeSchema.nullable(),
    evaluatedAt: timestamp.nullable(),
    claimedAt: timestamp.nullable(),
    attempts: nonNegativeInt,
    freebieSource: freebieSourceSchema.nullable(),
    freebieGrantedBy: uuid.nullable(),
    createdAt: timestamp,
  })
  .superRefine((p, ctx) => {
    // tower_periods_outcome_iff_evaluated
    const evaluated = p.state === 'evaluated';
    if (evaluated !== (p.outcome !== null) || evaluated !== (p.evaluatedAt !== null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'outcome and evaluatedAt are set exactly when state is evaluated',
        path: ['outcome'],
      });
    }
    // tower_periods_freebie_fields_iff_freebie
    if ((p.outcome === 'freebie') !== (p.freebieSource !== null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'freebieSource is set exactly when outcome is freebie',
        path: ['freebieSource'],
      });
    }
    // tower_periods_freebie_granted_by_requires_source
    if (p.freebieGrantedBy !== null && p.freebieSource === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'freebieGrantedBy requires a freebieSource',
        path: ['freebieGrantedBy'],
      });
    }
  });
export type TowerPeriodResponse = z.infer<typeof towerPeriodResponseSchema>;

export const baseBlockResponseSchema = z.object({
  id: uuid,
  towerId: uuid,
  // base_blocks_ordinal_positive / base_blocks_block_height_positive
  ordinal: positiveInt,
  runStartDate: localDate,
  runEndDate: localDate,
  blockHeight: positiveInt,
  // The same strict, non-empty validator the db layer uses on read (§5).
  roster: blockRosterSchema,
  createdAt: timestamp,
});
export type BaseBlockResponse = z.infer<typeof baseBlockResponseSchema>;
