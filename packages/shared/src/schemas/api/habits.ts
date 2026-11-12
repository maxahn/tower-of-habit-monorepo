import type { z } from 'zod';
import type { HabitStatus, HabitType, PeriodType } from '../enums.js';
import { notImplemented } from '../todo.js';
import type { CreateHabitTierRequest } from './tiers.js';

/*
 * Habit request/response bodies. Mirrors NewHabit / HabitPatch / Habit in
 * @tower-of-habit/db (habits/habits.ts) and the checks in habits/schema.ts.
 *
 * TODO(2.1): implement the three schemas below, then replace each hand-written
 * type with `z.infer<typeof …Schema>` so the schema is the single source.
 * Rules (tests: ./habits.test.ts):
 *   - strict objects: unknown keys are rejected, so ownerId / id / lifecycle /
 *     startedAt / createdAt can't be smuggled in (ownerId comes from auth);
 *   - name: 1..ROSTER_DISPLAY_NAME_MAX chars;
 *   - quota, periodLength: integers >= 1; periodUnit: periodTypeSchema;
 *   - create is a discriminated union on `type`:
 *       binary  → no unit (null allowed), no tiers
 *       numeric → unit required, no tiers            (habits_unit_iff_numeric)
 *       tiered  → no unit, tiers required, must include tierIndex 0, no
 *                 duplicate tierIndex (reuse createHabitTierRequestSchema);
 *   - update: every field optional, `{}` accepted; type, ownerId, lifecycle
 *     and tiers rejected (type is immutable; lifecycle moves via transitions);
 *   - response: timestamps are ISO-8601 strings with offset
 *     (z.iso.datetime({ offset: true })), nullable where the column is.
 */

type HabitFields = {
  name: string;
  periodUnit?: PeriodType;
  periodLength?: number;
  quota?: number;
};

export type CreateHabitRequest =
  | (HabitFields & { type: 'binary'; unit?: null })
  | (HabitFields & { type: 'numeric'; unit: string })
  | (HabitFields & { type: 'tiered'; unit?: null; tiers: CreateHabitTierRequest[] });

export type UpdateHabitRequest = Partial<HabitFields & { unit: string | null }>;

export type HabitResponse = {
  id: string;
  ownerId: string;
  name: string;
  type: HabitType;
  unit: string | null;
  periodUnit: PeriodType;
  periodLength: number;
  quota: number;
  lifecycle: HabitStatus;
  startedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export const createHabitRequestSchema = notImplemented<z.ZodType<CreateHabitRequest>>(
  'createHabitRequestSchema'
);
export const updateHabitRequestSchema = notImplemented<z.ZodType<UpdateHabitRequest>>(
  'updateHabitRequestSchema'
);
export const habitResponseSchema = notImplemented<z.ZodType<HabitResponse>>('habitResponseSchema');
