import { z } from 'zod';
import { NOTIFICATION_TYPES } from '../notifications/dedupe-key.js';

/*
 * Domain enums, one per Postgres enum (Phase 1 migrations).
 *
 * Each is ONE `as const` array; the union and the zod schema are both derived
 * from it, so they cannot drift from each other. Values are listed in pgEnum
 * declaration order, because Postgres sorts enum columns by it.
 *
 * Duplicated rather than imported from @tower-of-habit/db: the firewall keeps
 * drizzle out of this package. src/shared-enums.test.ts in that package
 * asserts every pg enum has a mirror here, equal in values, order and type.
 */

// habit_type
export const HABIT_TYPES = ['binary', 'numeric', 'tiered'] as const;
export type HabitType = (typeof HABIT_TYPES)[number];
export const habitTypeSchema = z.enum(HABIT_TYPES);

// habit_lifecycle
export const HABIT_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
export type HabitStatus = (typeof HABIT_STATUSES)[number];
export const habitStatusSchema = z.enum(HABIT_STATUSES);

// period_unit
export const PERIOD_TYPES = ['day', 'week'] as const;
export type PeriodType = (typeof PERIOD_TYPES)[number];
export const periodTypeSchema = z.enum(PERIOD_TYPES);

// tower_lifecycle
export const TOWER_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
export type TowerStatus = (typeof TOWER_STATUSES)[number];
export const towerStatusSchema = z.enum(TOWER_STATUSES);

// membership_state
export const MEMBERSHIP_STATES = ['active', 'at_risk', 'dormant', 'removed'] as const;
export type MembershipState = (typeof MEMBERSHIP_STATES)[number];
export const membershipStateSchema = z.enum(MEMBERSHIP_STATES);

// dormancy_reason
export const DORMANCY_REASONS = ['consecutive_miss', 'backstop', 'voluntary'] as const;
export type DormancyReason = (typeof DORMANCY_REASONS)[number];
export const dormancyReasonSchema = z.enum(DORMANCY_REASONS);

// period_state
export const PERIOD_STATUSES = ['pending', 'evaluating', 'evaluated'] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];
export const periodStatusSchema = z.enum(PERIOD_STATUSES);

// period_outcome
export const PERIOD_OUTCOMES = ['survived', 'collapsed', 'hibernated', 'freebie'] as const;
export type PeriodOutcome = (typeof PERIOD_OUTCOMES)[number];
export const periodOutcomeSchema = z.enum(PERIOD_OUTCOMES);

// freebie_source (provisional vocabulary, unused in v1)
export const FREEBIE_SOURCES = ['earned', 'host_granted', 'system'] as const;
export type FreebieSource = (typeof FREEBIE_SOURCES)[number];
export const freebieSourceSchema = z.enum(FREEBIE_SOURCES);

// push_platform
export const PUSH_PLATFORMS = ['ios', 'android'] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];
export const pushPlatformSchema = z.enum(PUSH_PLATFORMS);

// notification_status
export const NOTIFICATION_STATUSES = ['pending', 'sent', 'failed', 'skipped'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];
export const notificationStatusSchema = z.enum(NOTIFICATION_STATUSES);

// notification_type: the array already lives with the dedupe scopes it keys,
// so it is re-exported rather than redefined. Only the schema is new.
export { NOTIFICATION_TYPES, type NotificationType } from '../notifications/dedupe-key.js';
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);
