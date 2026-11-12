import { z } from 'zod';
import { periodTypeSchema, towerStatusSchema } from '../enums.js';
import {
  displayText,
  ianaTimeZone,
  nonNegativeInt,
  positiveInt,
  timestamp,
  uuid,
} from './common.js';

/*
 * Tower bodies. Mirrors NewTower / TowerPatch / Tower in @tower-of-habit/db
 * (towers/towers.ts) and the check constraints in towers/schema.ts.
 *
 * Requests are strict: hostId comes from the session; joinCode, lifecycle,
 * height, currentStreak and startedAt are server-owned.
 */

// No 0/O/1/I/L, so codes survive being read aloud or retyped. generateJoinCode
// in @tower-of-habit/db draws from these, so schema and generator agree.
export const JOIN_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const JOIN_CODE_LENGTH = 8;

/**
 * Must equal the column defaults in @tower-of-habit/db (towers/schema.ts).
 * Duplicated for the same reason as ROSTER_DISPLAY_NAME_MAX; towers.test.ts
 * in that package asserts the two agree.
 */
export const DEFAULT_WOBBLE_LEAD_MINUTES = 120;
export const DEFAULT_NUDGE_LEAD_MINUTES = 240;

const MINUTES_PER_DAY = 1440;

// The picker's HH:MM. Postgres would also take '24:00', but a tower deadline
// of midnight-at-end-of-day is SOLO_DEADLINE_TIME's job, not a host's.
const deadlineTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM');
// Postgres `time` reads back with seconds.
const storedDeadlineTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/, 'Expected HH:MM:SS');

// 0 = Sunday .. 6 = Saturday (towers_week_reset_day_range).
const weekResetDay = z.int().min(0).max(6);

const towerFields = {
  name: displayText,
  deadlineTime,
  timezone: ianaTimeZone,
  periodUnit: periodTypeSchema.optional(),
  periodLength: positiveInt.optional(),
  quota: positiveInt.optional(),
  weekResetDay: weekResetDay.nullable().optional(),
  // towers_wobble_lead_range / towers_nudge_lead_range
  wobbleLeadMinutes: z
    .int()
    .min(0)
    .max(MINUTES_PER_DAY - 1)
    .optional(),
  nudgeLeadMinutes: z
    .int()
    .min(0)
    .max(MINUTES_PER_DAY - 1)
    .optional(),
  // towers_grace_window_range
  graceWindowMinutes: z.int().min(0).max(360).optional(),
};

type TowerRules = {
  periodUnit?: 'day' | 'week' | undefined;
  periodLength?: number | undefined;
  quota?: number | undefined;
  weekResetDay?: number | null | undefined;
  wobbleLeadMinutes?: number | undefined;
  nudgeLeadMinutes?: number | undefined;
};

/**
 * The cross-field checks. On create, absent fields take the db defaults, so a
 * lone wobble that overtakes the default nudge is caught. On a patch, a rule
 * is checked only when both of its sides are present; the db constraints are
 * the backstop for combinations with stored values.
 */
function checkTowerRules(v: TowerRules, ctx: z.RefinementCtx, withDefaults: boolean): void {
  const pick = <T>(value: T | undefined, fallback: T): T | undefined =>
    value ?? (withDefaults ? fallback : undefined);

  // towers_nudge_before_wobble (§5): the private nudge precedes the broadcast.
  const wobble = pick(v.wobbleLeadMinutes, DEFAULT_WOBBLE_LEAD_MINUTES);
  const nudge = pick(v.nudgeLeadMinutes, DEFAULT_NUDGE_LEAD_MINUTES);
  if (wobble !== undefined && nudge !== undefined && nudge <= wobble) {
    ctx.addIssue({
      code: 'custom',
      message: 'nudgeLeadMinutes must be greater than wobbleLeadMinutes',
      path: [v.nudgeLeadMinutes !== undefined ? 'nudgeLeadMinutes' : 'wobbleLeadMinutes'],
    });
  }

  // towers_quota_range
  const quota = pick(v.quota, 1);
  const periodLength = pick(v.periodLength, 1);
  if (quota !== undefined && periodLength !== undefined && quota > periodLength) {
    ctx.addIssue({
      code: 'custom',
      message: 'quota cannot exceed periodLength',
      path: ['quota'],
    });
  }

  // towers_week_reset_day_iff_week
  const periodUnit = pick(v.periodUnit, 'day');
  if (periodUnit !== undefined && (withDefaults || v.weekResetDay !== undefined)) {
    const hasResetDay = v.weekResetDay !== undefined && v.weekResetDay !== null;
    if ((periodUnit === 'week') !== hasResetDay) {
      ctx.addIssue({
        code: 'custom',
        message: 'weekResetDay is required for weekly towers and forbidden otherwise',
        path: ['weekResetDay'],
      });
    }
  }
}

export const createTowerRequestSchema = z
  .strictObject(towerFields)
  .superRefine((v, ctx) => checkTowerRules(v, ctx, true));
export type CreateTowerRequest = z.infer<typeof createTowerRequestSchema>;

export const updateTowerRequestSchema = z
  .strictObject(towerFields)
  .partial()
  .superRefine((v, ctx) => checkTowerRules(v, ctx, false));
export type UpdateTowerRequest = z.infer<typeof updateTowerRequestSchema>;

// join_code is citext, so case never matters.
const joinCode = z
  .string()
  .regex(new RegExp(`^[${JOIN_CODE_ALPHABET}]{${JOIN_CODE_LENGTH}}$`, 'i'), 'Invalid join code');

export const joinTowerRequestSchema = z.strictObject({ joinCode, habitId: uuid });
export type JoinTowerRequest = z.infer<typeof joinTowerRequestSchema>;

export const towerResponseSchema = z.object({
  id: uuid,
  hostId: uuid,
  name: displayText,
  periodUnit: periodTypeSchema,
  periodLength: positiveInt,
  quota: positiveInt,
  deadlineTime: storedDeadlineTime,
  timezone: z.string(),
  weekResetDay: weekResetDay.nullable(),
  joinCode: z.string(),
  wobbleLeadMinutes: nonNegativeInt,
  nudgeLeadMinutes: z.int(),
  graceWindowMinutes: nonNegativeInt,
  lifecycle: towerStatusSchema,
  height: nonNegativeInt,
  currentStreak: nonNegativeInt,
  startedAt: timestamp.nullable(),
  createdAt: timestamp,
});
export type TowerResponse = z.infer<typeof towerResponseSchema>;
