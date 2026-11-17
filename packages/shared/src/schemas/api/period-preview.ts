import { z } from 'zod';
import { membershipStateSchema } from '../enums.js';
import { localDate, nonNegativeInt, positiveInt, timestamp, uuid } from './common.js';
import { towerPeriodResponseSchema } from './periods-blocks.js';

/*
 * 2.17: GET /towers/:id/period. The current period's live state, computed by
 * the same evaluatePeriod call the evaluation job makes, with nothing
 * persisted. Deliberately carries no transitions and no base block: those are
 * decisions, and the preview makes none.
 */

/** The 2.2 PeriodSchedule as JSON. */
export const periodScheduleSchema = z.strictObject({
  periodStart: localDate,
  periodEnd: localDate,
  nudgeAt: timestamp,
  wobbleAt: timestamp,
  deadlineAt: timestamp,
  evaluateAt: timestamp,
});
export type PeriodScheduleResponse = z.infer<typeof periodScheduleSchema>;

export const EVALUATION_STATUSES = ['open', 'wobbling', 'survived', 'collapsed'] as const;
export const evaluationStatusSchema = z.enum(EVALUATION_STATUSES);

export const MEMBER_STANDINGS = ['met', 'short', 'excused', 'excluded'] as const;
export const memberStandingSchema = z.enum(MEMBER_STANDINGS);

export const periodMemberPreviewSchema = z.strictObject({
  membershipId: uuid,
  userId: uuid,
  displayName: z.string().nullable(),
  state: membershipStateSchema,
  qualifyingDays: nonNegativeInt,
  standing: memberStandingSchema,
  daysNeeded: nonNegativeInt,
  daysRemaining: nonNegativeInt,
  slack: z.int(),
});
export type PeriodMemberPreview = z.infer<typeof periodMemberPreviewSchema>;

export const periodPreviewResponseSchema = z.strictObject({
  period: towerPeriodResponseSchema,
  window: periodScheduleSchema,
  /** The instant the preview was computed for (ctx.now). */
  now: timestamp,
  periodStatus: evaluationStatusSchema,
  quota: positiveInt,
  members: z.array(periodMemberPreviewSchema),
  /** Membership ids short of quota: who the tower is waiting on when wobbling. */
  outstanding: z.array(uuid),
  height: nonNegativeInt,
  currentStreak: nonNegativeInt,
});
export type PeriodPreviewResponse = z.infer<typeof periodPreviewResponseSchema>;
