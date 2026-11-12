import {
  DORMANCY_REASONS,
  FREEBIE_SOURCES,
  HABIT_STATUSES,
  HABIT_TYPES,
  MEMBERSHIP_STATES,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TYPES,
  PERIOD_OUTCOMES,
  PERIOD_STATUSES,
  PERIOD_TYPES,
  PUSH_PLATFORMS,
  TOWER_STATUSES,
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
} from '@tower-of-habit/shared';
import { isPgEnum } from 'drizzle-orm/pg-core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as schema from './schema.js';

/*
 * The drift guard for 2.1. @tower-of-habit/shared mirrors every Postgres enum
 * as a const array, because it can't import drizzle. This test pins the two
 * together, so a migration that changes an enum without updating shared fails
 * here (runtime) and in `pnpm typecheck` (type level).
 *
 * No database connection: schema definitions only.
 */

const MIRRORS: Record<string, readonly string[]> = {
  habit_type: HABIT_TYPES,
  habit_lifecycle: HABIT_STATUSES,
  period_unit: PERIOD_TYPES,
  tower_lifecycle: TOWER_STATUSES,
  membership_state: MEMBERSHIP_STATES,
  dormancy_reason: DORMANCY_REASONS,
  period_state: PERIOD_STATUSES,
  period_outcome: PERIOD_OUTCOMES,
  freebie_source: FREEBIE_SOURCES,
  push_platform: PUSH_PLATFORMS,
  notification_status: NOTIFICATION_STATUSES,
  notification_type: NOTIFICATION_TYPES,
};

// unknown[] first: the type guard only narrows when PgEnum is a subtype of the element type.
const pgEnums = (Object.values(schema) as unknown[]).filter(isPgEnum);

describe('shared enum mirrors', () => {
  // A new pgEnum in a Phase 1 migration must get a shared counterpart.
  it('mirrors every pg enum in the schema', () => {
    expect(pgEnums.map((e) => e.enumName).sort()).toEqual(Object.keys(MIRRORS).sort());
  });

  // Order matters: Postgres sorts enum columns by declaration order.
  it.each(pgEnums.map((e) => [e.enumName, e] as const))(
    '%s matches its shared mirror, in order',
    (name, pgEnum) => {
      expect([...(MIRRORS[name] ?? [])]).toEqual([...pgEnum.enumValues]);
    }
  );

  // Equality, not one-way assignability: "mirror exactly" fails in either
  // direction — a value dropped from shared or one added to Postgres.
  it('matches each Drizzle enum at the type level', () => {
    type Values<E extends { enumValues: readonly string[] }> = E['enumValues'][number];

    expectTypeOf<HabitType>().toEqualTypeOf<Values<typeof schema.habitTypeEnum>>();
    expectTypeOf<HabitStatus>().toEqualTypeOf<Values<typeof schema.habitLifecycleEnum>>();
    expectTypeOf<PeriodType>().toEqualTypeOf<Values<typeof schema.periodUnitEnum>>();
    expectTypeOf<TowerStatus>().toEqualTypeOf<Values<typeof schema.towerLifecycleEnum>>();
    expectTypeOf<MembershipState>().toEqualTypeOf<Values<typeof schema.membershipStateEnum>>();
    expectTypeOf<DormancyReason>().toEqualTypeOf<Values<typeof schema.dormancyReasonEnum>>();
    expectTypeOf<PeriodStatus>().toEqualTypeOf<Values<typeof schema.periodStateEnum>>();
    expectTypeOf<PeriodOutcome>().toEqualTypeOf<Values<typeof schema.periodOutcomeEnum>>();
    expectTypeOf<FreebieSource>().toEqualTypeOf<Values<typeof schema.freebieSourceEnum>>();
    expectTypeOf<PushPlatform>().toEqualTypeOf<Values<typeof schema.pushPlatformEnum>>();
    expectTypeOf<NotificationStatus>().toEqualTypeOf<
      Values<typeof schema.notificationStatusEnum>
    >();
    expectTypeOf<NotificationType>().toEqualTypeOf<Values<typeof schema.notificationTypeEnum>>();
  });

  // The column types Drizzle infers for rows must accept the shared unions,
  // which is what the API layer relies on when it maps a row to a response.
  it('lets shared unions flow into inferred row types', () => {
    expectTypeOf<HabitStatus>().toExtend<(typeof schema.habits.$inferSelect)['lifecycle']>();
    expectTypeOf<TowerStatus>().toExtend<(typeof schema.towers.$inferSelect)['lifecycle']>();
    expectTypeOf<MembershipState>().toExtend<(typeof schema.memberships.$inferSelect)['state']>();
    expectTypeOf<PeriodStatus>().toExtend<(typeof schema.towerPeriods.$inferSelect)['state']>();
  });
});
