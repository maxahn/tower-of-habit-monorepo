import { z } from 'zod';
import {
  habitStatusSchema,
  habitTypeSchema,
  membershipStateSchema,
  periodTypeSchema,
  towerStatusSchema,
} from '../enums.js';
import { displayText, nonNegativeInt, positiveInt, timestamp, uuid } from './common.js';
import {
  createHabitTierRequestSchema,
  habitTierResponseSchema,
  tierLadderIssues,
} from './tiers.js';

/*
 * Habit bodies. Mirrors NewHabit / HabitPatch / Habit in @tower-of-habit/db
 * (habits/habits.ts) and the checks in habits/schema.ts.
 *
 * Requests are strict: ownerId comes from the session, and lifecycle with its
 * timestamps moves only through transitions, so none of them may ride along.
 */

const habitFields = {
  name: displayText,
  periodUnit: periodTypeSchema.optional(),
  // habits_period_length_positive / habits_quota_positive
  periodLength: positiveInt.optional(),
  quota: positiveInt.optional(),
};

const ladder = z.array(createHabitTierRequestSchema).min(1);

/** Applies tierLadderIssues (2.12) as zod issues under `tiers`. */
function refineLadder(type: 'numeric' | 'tiered') {
  return ({ tiers }: { tiers: z.infer<typeof ladder> }, ctx: z.RefinementCtx): void => {
    for (const issue of tierLadderIssues(type, tiers)) {
      ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path.split('.') });
    }
  };
}

// habits_unit_iff_numeric: a unit on exactly the numeric habits.
const binaryHabit = z.strictObject({
  ...habitFields,
  type: z.literal('binary'),
  unit: z.null().optional(),
});

// 2.12 / DECISIONS P9: a numeric habit carries a ladder; tier 0's threshold is
// what qualifies() checks.
const numericHabit = z
  .strictObject({
    ...habitFields,
    type: z.literal('numeric'),
    unit: displayText,
    tiers: ladder,
  })
  .superRefine(refineLadder('numeric'));

// A tiered habit is created with its tiers, which must include the base tier.
const tieredHabit = z
  .strictObject({
    ...habitFields,
    type: z.literal('tiered'),
    unit: z.null().optional(),
    tiers: ladder,
  })
  .superRefine(refineLadder('tiered'));

export const createHabitRequestSchema = z.discriminatedUnion('type', [
  binaryHabit,
  numericHabit,
  tieredHabit,
]);
export type CreateHabitRequest = z.infer<typeof createHabitRequestSchema>;

// Type is immutable (a change would break the tier invariant), so it is not
// patchable; neither are tiers, which have their own endpoint.
export const updateHabitRequestSchema = z
  .strictObject({ ...habitFields, unit: displayText.nullable() })
  .partial();
export type UpdateHabitRequest = z.infer<typeof updateHabitRequestSchema>;

export const habitResponseSchema = z.object({
  id: uuid,
  ownerId: uuid,
  name: displayText,
  type: habitTypeSchema,
  unit: displayText.nullable(),
  periodUnit: periodTypeSchema,
  periodLength: positiveInt,
  quota: positiveInt,
  lifecycle: habitStatusSchema,
  startedAt: timestamp.nullable(),
  archivedAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type HabitResponse = z.infer<typeof habitResponseSchema>;

/** The tower a habit is bound into, as GET /habits/:id summarises it. */
export const habitTowerSummarySchema = z.object({
  id: uuid,
  name: displayText,
  lifecycle: towerStatusSchema,
  membershipState: membershipStateSchema,
});
export type HabitTowerSummary = z.infer<typeof habitTowerSummarySchema>;

/** GET /habits/:id (and every habit write): the habit with its context. */
export const habitDetailResponseSchema = z.object({
  habit: habitResponseSchema,
  /** The ladder, by tierIndex. Empty for binary habits. */
  tiers: z.array(habitTierResponseSchema),
  /** Consecutive qualifying days ending today or yesterday. */
  currentStreak: nonNegativeInt,
  tower: habitTowerSummarySchema.nullable(),
});
export type HabitDetailResponse = z.infer<typeof habitDetailResponseSchema>;

export const habitListResponseSchema = z.object({ habits: z.array(habitResponseSchema) });
export type HabitListResponse = z.infer<typeof habitListResponseSchema>;
