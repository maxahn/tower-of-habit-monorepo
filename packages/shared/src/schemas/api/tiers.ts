import type { z } from 'zod';
import { notImplemented } from '../todo.js';

/*
 * Habit tier bodies. Mirrors NewHabitTier / HabitTierPatch / HabitTier in
 * @tower-of-habit/db (habits/tiers/tiers.ts). habitId comes from the route.
 *
 * TODO(2.1): implement, then replace the hand-written types with z.infer.
 * Rules (tests: ./tiers.test.ts):
 *   - strict: habitId (and any unknown key) rejected;
 *   - tierIndex: integer >= 0 (tier 0 is the base tier);
 *   - label: 1..ROSTER_DISPLAY_NAME_MAX chars;
 *   - thresholdValue: finite number or null (no NaN/Infinity, no strings);
 *   - update: all optional, `{}` accepted, same field rules;
 *   - response adds id and habitId (uuids).
 */

export type CreateHabitTierRequest = {
  tierIndex: number;
  label: string;
  thresholdValue: number | null;
};

export type UpdateHabitTierRequest = Partial<CreateHabitTierRequest>;

export type HabitTierResponse = CreateHabitTierRequest & { id: string; habitId: string };

export const createHabitTierRequestSchema = notImplemented<z.ZodType<CreateHabitTierRequest>>(
  'createHabitTierRequestSchema'
);
export const updateHabitTierRequestSchema = notImplemented<z.ZodType<UpdateHabitTierRequest>>(
  'updateHabitTierRequestSchema'
);
export const habitTierResponseSchema =
  notImplemented<z.ZodType<HabitTierResponse>>('habitTierResponseSchema');
