import { z } from 'zod';
import { dormancyReasonSchema, membershipStateSchema, periodOutcomeSchema } from '../enums.js';
import { localDate, nonNegativeInt, uuid } from './common.js';
import { memberStandingSchema } from './period-preview.js';
import { baseBlockResponseSchema, towerPeriodResponseSchema } from './periods-blocks.js';

/*
 * 2.19: the persisted outcome of an evaluation. Strict at every level: no
 * blame field can ride along (§5), here or on the block.
 */

export const membershipTransitionSchema = z.strictObject({
  membershipId: uuid,
  type: z.enum(['at_risk', 'recovered', 'dormant', 'returned']),
  from: membershipStateSchema,
  to: membershipStateSchema,
  dormancyReason: dormancyReasonSchema.optional(),
  reason: z.enum([
    'missed_period',
    'met_quota',
    'consecutive_miss',
    'backstop',
    'logged',
    'return_date_reached',
  ]),
  effectiveFrom: localDate,
});
export type MembershipTransitionResponse = z.infer<typeof membershipTransitionSchema>;

export const evaluationResponseSchema = z.strictObject({
  period: towerPeriodResponseSchema,
  outcome: periodOutcomeSchema,
  perMember: z.array(
    z.strictObject({
      membershipId: uuid,
      standing: memberStandingSchema,
      consecutiveMisses: nonNegativeInt,
    })
  ),
  transitions: z.array(membershipTransitionSchema),
  // Strict here even though the read schema is not: nothing may ride along on a block.
  baseBlock: baseBlockResponseSchema.strict().nullable(),
  nextPeriod: towerPeriodResponseSchema.nullable(),
  tower: z.strictObject({ height: nonNegativeInt, currentStreak: nonNegativeInt }),
});
export type EvaluationResponse = z.infer<typeof evaluationResponseSchema>;
