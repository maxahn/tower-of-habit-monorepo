import { z } from 'zod';
import { habitStatusSchema, habitTypeSchema, periodTypeSchema } from '../enums.js';
import { displayText, positiveInt, timestamp, uuid } from './common.js';
import { createHabitTierRequestSchema } from './tiers.js';

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

// habits_unit_iff_numeric: a unit on exactly the numeric habits.
const binaryHabit = z.strictObject({
  ...habitFields,
  type: z.literal('binary'),
  unit: z.null().optional(),
});

const numericHabit = z.strictObject({
  ...habitFields,
  type: z.literal('numeric'),
  unit: displayText,
});

// A tiered habit is created with its tiers, which must include the base tier.
const tieredHabit = z
  .strictObject({
    ...habitFields,
    type: z.literal('tiered'),
    unit: z.null().optional(),
    tiers: z.array(createHabitTierRequestSchema).min(1),
  })
  .superRefine(({ tiers }, ctx) => {
    if (!tiers.some((t) => t.tierIndex === 0)) {
      ctx.addIssue({ code: 'custom', message: 'tiers must include tierIndex 0', path: ['tiers'] });
    }
    const seen = new Set<number>();
    tiers.forEach((t, i) => {
      if (seen.has(t.tierIndex)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate tierIndex ${t.tierIndex}`,
          path: ['tiers', i, 'tierIndex'],
        });
      }
      seen.add(t.tierIndex);
    });
  });

export const createHabitRequestSchema = z.discriminatedUnion('type', [
  binaryHabit,
  numericHabit,
  tieredHabit,
]);
export type CreateHabitRequest = z.infer<typeof createHabitRequestSchema>;

// Type is immutable (a change would break the tier invariant), so it is not
// patchable; neither are tiers, which have their own endpoints.
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
