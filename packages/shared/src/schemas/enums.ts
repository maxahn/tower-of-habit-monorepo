import type { z } from 'zod';
import { NOTIFICATION_TYPES } from '../notifications/dedupe-key.js';
import { notImplemented } from './todo.js';

/*
 * Domain enums, one per Postgres enum (Phase 1 migrations).
 *
 * TODO(2.1): for each enum below
 *   1. replace the stub with the real tuple: `export const HABIT_TYPES = [...] as const;`
 *      in the SAME order as the pgEnum declaration (Postgres sorts by it);
 *   2. derive the union from it: `export type HabitType = (typeof HABIT_TYPES)[number];`
 *   3. build the schema from the same array: `export const habitTypeSchema = z.enum(HABIT_TYPES);`
 *   4. drop the `type` import of zod in favour of a value import, and delete the
 *      EnumSchema helper below.
 * Tests: ./enums.test.ts here, and src/shared-enums.test.ts in @tower-of-habit/db
 * (the drift guard against the Drizzle enums).
 *
 * The stubs already carry the final types, so `pnpm typecheck` passes and
 * the runtime tests fail with a TODO(2.1) error until each one lands.
 */

/** TODO(2.1): stub-only helper; z.enum(ARRAY) infers this type by itself. */
type EnumSchema<V extends readonly string[]> = z.ZodEnum<{ [K in V[number]]: K }>;

// habit_type
export const HABIT_TYPES = notImplemented<readonly ['binary', 'numeric', 'tiered']>('HABIT_TYPES');
export type HabitType = (typeof HABIT_TYPES)[number];
export const habitTypeSchema = notImplemented<EnumSchema<typeof HABIT_TYPES>>('habitTypeSchema');

// habit_lifecycle
export const HABIT_STATUSES =
  notImplemented<readonly ['draft', 'active', 'paused', 'archived']>('HABIT_STATUSES');
export type HabitStatus = (typeof HABIT_STATUSES)[number];
export const habitStatusSchema =
  notImplemented<EnumSchema<typeof HABIT_STATUSES>>('habitStatusSchema');

// period_unit
export const PERIOD_TYPES = notImplemented<readonly ['day', 'week']>('PERIOD_TYPES');
export type PeriodType = (typeof PERIOD_TYPES)[number];
export const periodTypeSchema = notImplemented<EnumSchema<typeof PERIOD_TYPES>>('periodTypeSchema');

// tower_lifecycle
export const TOWER_STATUSES =
  notImplemented<readonly ['draft', 'active', 'paused', 'archived']>('TOWER_STATUSES');
export type TowerStatus = (typeof TOWER_STATUSES)[number];
export const towerStatusSchema =
  notImplemented<EnumSchema<typeof TOWER_STATUSES>>('towerStatusSchema');

// membership_state
export const MEMBERSHIP_STATES =
  notImplemented<readonly ['active', 'at_risk', 'dormant', 'removed']>('MEMBERSHIP_STATES');
export type MembershipState = (typeof MEMBERSHIP_STATES)[number];
export const membershipStateSchema =
  notImplemented<EnumSchema<typeof MEMBERSHIP_STATES>>('membershipStateSchema');

// dormancy_reason
export const DORMANCY_REASONS =
  notImplemented<readonly ['consecutive_miss', 'backstop', 'voluntary']>('DORMANCY_REASONS');
export type DormancyReason = (typeof DORMANCY_REASONS)[number];
export const dormancyReasonSchema =
  notImplemented<EnumSchema<typeof DORMANCY_REASONS>>('dormancyReasonSchema');

// period_state
export const PERIOD_STATUSES =
  notImplemented<readonly ['pending', 'evaluating', 'evaluated']>('PERIOD_STATUSES');
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];
export const periodStatusSchema =
  notImplemented<EnumSchema<typeof PERIOD_STATUSES>>('periodStatusSchema');

// period_outcome
export const PERIOD_OUTCOMES =
  notImplemented<readonly ['survived', 'collapsed', 'hibernated', 'freebie']>('PERIOD_OUTCOMES');
export type PeriodOutcome = (typeof PERIOD_OUTCOMES)[number];
export const periodOutcomeSchema =
  notImplemented<EnumSchema<typeof PERIOD_OUTCOMES>>('periodOutcomeSchema');

// freebie_source
export const FREEBIE_SOURCES =
  notImplemented<readonly ['earned', 'host_granted', 'system']>('FREEBIE_SOURCES');
export type FreebieSource = (typeof FREEBIE_SOURCES)[number];
export const freebieSourceSchema =
  notImplemented<EnumSchema<typeof FREEBIE_SOURCES>>('freebieSourceSchema');

// push_platform
export const PUSH_PLATFORMS = notImplemented<readonly ['ios', 'android']>('PUSH_PLATFORMS');
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];
export const pushPlatformSchema =
  notImplemented<EnumSchema<typeof PUSH_PLATFORMS>>('pushPlatformSchema');

// notification_status
export const NOTIFICATION_STATUSES =
  notImplemented<readonly ['pending', 'sent', 'failed', 'skipped']>('NOTIFICATION_STATUSES');
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];
export const notificationStatusSchema = notImplemented<EnumSchema<typeof NOTIFICATION_STATUSES>>(
  'notificationStatusSchema'
);

// notification_type: the array already exists (dedupe scopes), so it is
// re-exported, not redefined. Only the schema is new.
export { NOTIFICATION_TYPES, type NotificationType } from '../notifications/dedupe-key.js';
export const notificationTypeSchema =
  notImplemented<EnumSchema<typeof NOTIFICATION_TYPES>>('notificationTypeSchema');
