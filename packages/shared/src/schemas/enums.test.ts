import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  DORMANCY_REASONS,
  dormancyReasonSchema,
  FREEBIE_SOURCES,
  freebieSourceSchema,
  HABIT_STATUSES,
  HABIT_TYPES,
  habitStatusSchema,
  habitTypeSchema,
  MEMBERSHIP_STATES,
  membershipStateSchema,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TYPES,
  notificationStatusSchema,
  notificationTypeSchema,
  PERIOD_OUTCOMES,
  PERIOD_STATUSES,
  PERIOD_TYPES,
  periodOutcomeSchema,
  periodStatusSchema,
  periodTypeSchema,
  PUSH_PLATFORMS,
  pushPlatformSchema,
  TOWER_STATUSES,
  towerStatusSchema,
  type DormancyReason,
  type FreebieSource,
  type HabitStatus,
  type HabitType,
  type MembershipState,
  type NotificationStatus,
  type NotificationType,
  type PeriodOutcome,
  type PeriodStatus,
  type PeriodType,
  type PushPlatform,
  type TowerStatus,
} from './index.js';

/*
 * Each union is derived from one `as const` array, and its zod schema is built
 * from that same array, so the two cannot drift. These tests pin that wiring.
 *
 * Exact equality with the Postgres enums is checked in @tower-of-habit/db
 * (src/shared-enums.test.ts), because this package must not import drizzle.
 * The literal values below are a second, deliberate copy: if a migration
 * changes an enum, both that test and this one must be updated on purpose.
 */

type EnumCase = {
  name: string;
  values: readonly string[];
  schema: z.ZodType<string> & { options: readonly string[] };
  expected: readonly string[];
};

const CASES: EnumCase[] = [
  {
    name: 'HabitType',
    values: HABIT_TYPES,
    schema: habitTypeSchema,
    expected: ['binary', 'numeric', 'tiered'],
  },
  {
    name: 'HabitStatus (habit_lifecycle)',
    values: HABIT_STATUSES,
    schema: habitStatusSchema,
    expected: ['draft', 'active', 'paused', 'archived'],
  },
  {
    name: 'PeriodType (period_unit)',
    values: PERIOD_TYPES,
    schema: periodTypeSchema,
    expected: ['day', 'week'],
  },
  {
    name: 'TowerStatus (tower_lifecycle)',
    values: TOWER_STATUSES,
    schema: towerStatusSchema,
    expected: ['draft', 'active', 'paused', 'archived'],
  },
  {
    name: 'MembershipState',
    values: MEMBERSHIP_STATES,
    schema: membershipStateSchema,
    expected: ['active', 'at_risk', 'dormant', 'removed'],
  },
  {
    name: 'DormancyReason',
    values: DORMANCY_REASONS,
    schema: dormancyReasonSchema,
    expected: ['consecutive_miss', 'backstop', 'voluntary'],
  },
  {
    name: 'PeriodStatus (period_state)',
    values: PERIOD_STATUSES,
    schema: periodStatusSchema,
    expected: ['pending', 'evaluating', 'evaluated'],
  },
  {
    name: 'PeriodOutcome',
    values: PERIOD_OUTCOMES,
    schema: periodOutcomeSchema,
    expected: ['survived', 'collapsed', 'hibernated', 'freebie'],
  },
  {
    name: 'FreebieSource',
    values: FREEBIE_SOURCES,
    schema: freebieSourceSchema,
    expected: ['earned', 'host_granted', 'system'],
  },
  {
    name: 'PushPlatform',
    values: PUSH_PLATFORMS,
    schema: pushPlatformSchema,
    expected: ['ios', 'android'],
  },
  {
    name: 'NotificationStatus',
    values: NOTIFICATION_STATUSES,
    schema: notificationStatusSchema,
    expected: ['pending', 'sent', 'failed', 'skipped'],
  },
  {
    name: 'NotificationType',
    values: NOTIFICATION_TYPES,
    schema: notificationTypeSchema,
    expected: [
      'nudge',
      'wobble',
      'collapse',
      'dormant',
      'returned',
      'member_joined',
      'tower_started',
      'tower_archived',
      'block_completed',
      'host_transferred',
    ],
  },
];

describe.each(CASES)('$name', ({ values, schema, expected }) => {
  // Order matters: Postgres sorts enum columns by declaration order.
  it('lists exactly the Postgres values, in declaration order', () => {
    expect([...values]).toEqual(expected);
  });

  it('builds the zod schema from the same array', () => {
    expect([...schema.options]).toEqual([...values]);
  });

  it('has no duplicate values', () => {
    expect(new Set(values).size).toBe(values.length);
  });

  it.each(expected)('accepts %p', (value) => {
    expect(schema.safeParse(value).success).toBe(true);
  });

  it.each(['', 'unknown_value', expected[0]!.toUpperCase(), ` ${expected[0]}`, null, undefined, 0])(
    'rejects %p',
    (value) => {
      expect(schema.safeParse(value).success).toBe(false);
    }
  );
});

// Type-level only: enforced by `tsc --noEmit` (pnpm typecheck), not by vitest.
describe('enum unions (type level)', () => {
  it('derives each union from its const array', () => {
    expectTypeOf<HabitType>().toEqualTypeOf<(typeof HABIT_TYPES)[number]>();
    expectTypeOf<HabitStatus>().toEqualTypeOf<(typeof HABIT_STATUSES)[number]>();
    expectTypeOf<PeriodType>().toEqualTypeOf<(typeof PERIOD_TYPES)[number]>();
    expectTypeOf<TowerStatus>().toEqualTypeOf<(typeof TOWER_STATUSES)[number]>();
    expectTypeOf<MembershipState>().toEqualTypeOf<(typeof MEMBERSHIP_STATES)[number]>();
    expectTypeOf<DormancyReason>().toEqualTypeOf<(typeof DORMANCY_REASONS)[number]>();
    expectTypeOf<PeriodStatus>().toEqualTypeOf<(typeof PERIOD_STATUSES)[number]>();
    expectTypeOf<PeriodOutcome>().toEqualTypeOf<(typeof PERIOD_OUTCOMES)[number]>();
    expectTypeOf<FreebieSource>().toEqualTypeOf<(typeof FREEBIE_SOURCES)[number]>();
    expectTypeOf<PushPlatform>().toEqualTypeOf<(typeof PUSH_PLATFORMS)[number]>();
    expectTypeOf<NotificationStatus>().toEqualTypeOf<(typeof NOTIFICATION_STATUSES)[number]>();
    expectTypeOf<NotificationType>().toEqualTypeOf<(typeof NOTIFICATION_TYPES)[number]>();
  });

  it('infers the same union from each zod schema', () => {
    expectTypeOf<z.infer<typeof habitTypeSchema>>().toEqualTypeOf<HabitType>();
    expectTypeOf<z.infer<typeof habitStatusSchema>>().toEqualTypeOf<HabitStatus>();
    expectTypeOf<z.infer<typeof periodTypeSchema>>().toEqualTypeOf<PeriodType>();
    expectTypeOf<z.infer<typeof towerStatusSchema>>().toEqualTypeOf<TowerStatus>();
    expectTypeOf<z.infer<typeof membershipStateSchema>>().toEqualTypeOf<MembershipState>();
    expectTypeOf<z.infer<typeof dormancyReasonSchema>>().toEqualTypeOf<DormancyReason>();
    expectTypeOf<z.infer<typeof periodStatusSchema>>().toEqualTypeOf<PeriodStatus>();
    expectTypeOf<z.infer<typeof periodOutcomeSchema>>().toEqualTypeOf<PeriodOutcome>();
    expectTypeOf<z.infer<typeof freebieSourceSchema>>().toEqualTypeOf<FreebieSource>();
    expectTypeOf<z.infer<typeof pushPlatformSchema>>().toEqualTypeOf<PushPlatform>();
    expectTypeOf<z.infer<typeof notificationStatusSchema>>().toEqualTypeOf<NotificationStatus>();
    expectTypeOf<z.infer<typeof notificationTypeSchema>>().toEqualTypeOf<NotificationType>();
  });

  it('keeps every union a literal union, never string or any', () => {
    expectTypeOf<HabitType>().not.toBeAny();
    expectTypeOf<string>().not.toExtend<HabitType>();
    expectTypeOf<string>().not.toExtend<HabitStatus>();
    expectTypeOf<string>().not.toExtend<PeriodType>();
    expectTypeOf<string>().not.toExtend<TowerStatus>();
    expectTypeOf<string>().not.toExtend<MembershipState>();
    expectTypeOf<string>().not.toExtend<DormancyReason>();
    expectTypeOf<string>().not.toExtend<PeriodStatus>();
    expectTypeOf<string>().not.toExtend<PeriodOutcome>();
    expectTypeOf<string>().not.toExtend<FreebieSource>();
    expectTypeOf<string>().not.toExtend<PushPlatform>();
    expectTypeOf<string>().not.toExtend<NotificationStatus>();
  });
});
