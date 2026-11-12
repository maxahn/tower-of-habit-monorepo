import type { z } from 'zod';
import type { PeriodType, TowerStatus } from '../enums.js';
import { notImplemented } from '../todo.js';

/*
 * Tower bodies. Mirrors NewTower / TowerPatch / Tower in @tower-of-habit/db
 * (towers/towers.ts) and the check constraints in towers/schema.ts.
 *
 * TODO(2.1): implement, then replace the hand-written types with z.infer.
 * Rules (tests: ./towers.test.ts):
 *   - strict: hostId, joinCode, lifecycle, height, currentStreak, startedAt
 *     rejected (hostId from auth; the rest are server-owned);
 *   - name: 1..ROSTER_DISPLAY_NAME_MAX chars;
 *   - deadlineTime (request): "HH:MM", 00:00..23:59;
 *   - timezone: same rule as isValidTimeZone in @tower-of-habit/db;
 *   - graceWindowMinutes: integer 0..360;
 *   - wobbleLeadMinutes: integer 0..1439; nudgeLeadMinutes: integer < 1440;
 *   - nudge > wobble, checked AFTER applying the db defaults (wobble 120,
 *     nudge 240) on create, so a lone wobble of 300 is rejected;
 *   - quota: integer >= 1 and <= periodLength (periodLength defaults to 1);
 *   - weekResetDay: integer 0..6, present iff periodUnit === 'week';
 *   - update: all optional, `{}` accepted; pairwise rules only when both
 *     sides are in the patch (the db constraint backs up the rest);
 *   - join: joinCode is 8 chars of generateJoinCode's alphabet (no 0/O/1/I/L),
 *     case-insensitive (citext); habitId uuid; userId rejected;
 *   - response: deadlineTime is "HH:MM:SS" (Postgres `time`); height and
 *     currentStreak >= 0; timestamps ISO-8601 with offset.
 */

export type CreateTowerRequest = {
  name: string;
  deadlineTime: string;
  timezone: string;
  periodUnit?: PeriodType;
  periodLength?: number;
  quota?: number;
  weekResetDay?: number | null;
  wobbleLeadMinutes?: number;
  nudgeLeadMinutes?: number;
  graceWindowMinutes?: number;
};

export type UpdateTowerRequest = Partial<CreateTowerRequest>;

export type JoinTowerRequest = { joinCode: string; habitId: string };

export type TowerResponse = {
  id: string;
  hostId: string;
  name: string;
  periodUnit: PeriodType;
  periodLength: number;
  quota: number;
  deadlineTime: string;
  timezone: string;
  weekResetDay: number | null;
  joinCode: string;
  wobbleLeadMinutes: number;
  nudgeLeadMinutes: number;
  graceWindowMinutes: number;
  lifecycle: TowerStatus;
  height: number;
  currentStreak: number;
  startedAt: string | null;
  createdAt: string;
};

export const createTowerRequestSchema = notImplemented<z.ZodType<CreateTowerRequest>>(
  'createTowerRequestSchema'
);
export const updateTowerRequestSchema = notImplemented<z.ZodType<UpdateTowerRequest>>(
  'updateTowerRequestSchema'
);
export const joinTowerRequestSchema =
  notImplemented<z.ZodType<JoinTowerRequest>>('joinTowerRequestSchema');
export const towerResponseSchema = notImplemented<z.ZodType<TowerResponse>>('towerResponseSchema');
