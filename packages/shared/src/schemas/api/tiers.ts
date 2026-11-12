import { z } from 'zod';
import { displayText, nonNegativeInt, uuid } from './common.js';

/*
 * Habit tier bodies. Mirrors NewHabitTier / HabitTierPatch / HabitTier in
 * @tower-of-habit/db (habits/tiers/tiers.ts). habitId comes from the route,
 * so request bodies are strict and reject it.
 */

const tierFields = {
  // habit_tiers_tier_index_nonnegative. Tier 0 is the base tier.
  tierIndex: nonNegativeInt,
  label: displayText,
  // Finite only: z.number() already rejects NaN and ±Infinity.
  thresholdValue: z.number().nullable(),
};

export const createHabitTierRequestSchema = z.strictObject(tierFields);
export type CreateHabitTierRequest = z.infer<typeof createHabitTierRequestSchema>;

export const updateHabitTierRequestSchema = createHabitTierRequestSchema.partial();
export type UpdateHabitTierRequest = z.infer<typeof updateHabitTierRequestSchema>;

export const habitTierResponseSchema = z.object({ id: uuid, habitId: uuid, ...tierFields });
export type HabitTierResponse = z.infer<typeof habitTierResponseSchema>;
