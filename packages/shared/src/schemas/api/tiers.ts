import { z } from 'zod';
import type { HabitType } from '../enums.js';
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

/** PUT /habits/:id/tiers: the whole ladder, replaced at once (2.12). */
export const replaceTiersRequestSchema = z.strictObject({
  tiers: z.array(createHabitTierRequestSchema).min(1),
});
export type ReplaceTiersRequest = z.infer<typeof replaceTiersRequestSchema>;

/** One ladder problem, with a dotted path for validation_failed details. */
export type LadderIssue = { path: string; message: string };

/**
 * 2.12: a tier ladder is one consistent object, checked as a whole.
 *   - binary habits have no ladder;
 *   - numeric and tiered ladders are non-empty with levels contiguous from 0;
 *   - numeric thresholds are all set and strictly increasing by level (tier 0
 *     is what qualifies() checks, so it can never be null).
 * Order of the input does not matter. The same rule serves the create schema
 * and PUT /habits/:id/tiers, whose handler supplies the habit type.
 */
export function tierLadderIssues(
  type: HabitType,
  tiers: readonly CreateHabitTierRequest[]
): LadderIssue[] {
  const issues: LadderIssue[] = [];
  if (type === 'binary') {
    if (tiers.length > 0) issues.push({ path: 'tiers', message: 'binary habits have no tiers' });
    return issues;
  }
  if (tiers.length === 0) {
    issues.push({ path: 'tiers', message: 'at least one tier (tier 0) is required' });
    return issues;
  }
  const byIndex = new Map<number, number>();
  tiers.forEach((t, i) => {
    if (byIndex.has(t.tierIndex)) {
      issues.push({ path: `tiers.${i}.tierIndex`, message: `duplicate tierIndex ${t.tierIndex}` });
    } else {
      byIndex.set(t.tierIndex, i);
    }
  });
  for (let level = 0; level < tiers.length; level++) {
    if (!byIndex.has(level)) {
      issues.push({
        path: 'tiers',
        message: level === 0 ? 'tiers must include tierIndex 0' : `tierIndex ${level} is missing`,
      });
      break;
    }
  }
  if (type === 'numeric') {
    let previous: number | null = null;
    for (let level = 0; level < tiers.length; level++) {
      const i = byIndex.get(level);
      if (i === undefined) break;
      const value = tiers[i]!.thresholdValue;
      if (value === null) {
        issues.push({
          path: `tiers.${i}.thresholdValue`,
          message: 'numeric habits need a threshold on every tier',
        });
        break;
      }
      if (previous !== null && value <= previous) {
        issues.push({
          path: `tiers.${i}.thresholdValue`,
          message: 'numeric thresholds must be strictly increasing',
        });
        break;
      }
      previous = value;
    }
  }
  return issues;
}
