import { inArray } from 'drizzle-orm';
import type { ScenarioPlan } from '@tower-of-habit/shared/testing';
import type { Db } from '../client.js';
import type { Entry } from '../habits/entries/entries.js';
import { entries } from '../habits/entries/schema.js';
import type { Habit } from '../habits/habits.js';
import { habits } from '../habits/schema.js';
import { habitTiers } from '../habits/tiers/schema.js';
import { appendBaseBlock, type BaseBlock } from '../towers/blocks/blocks.js';
import type { Membership } from '../towers/memberships/memberships.js';
import { memberships } from '../towers/memberships/schema.js';
import type { TowerPeriod } from '../towers/periods/periods.js';
import { towerPeriods } from '../towers/periods/schema.js';
import { towers } from '../towers/schema.js';
import {
  generateJoinCode,
  InvalidTimeZoneError,
  isValidTimeZone,
  type Tower,
} from '../towers/towers.js';
import type { User } from '../users/users.js';
import { users } from '../users/schema.js';

/** A persisted plan: the rows as the database returned them, by role. */
export type Scenario = {
  plan: ScenarioPlan;
  /** The plan's instant. Hand it to whatever is under test. */
  now: Date;
  users: User[];
  habits: Habit[];
  tower: Tower | null;
  /** Same order as plan.members: the host first. */
  members: { user: User; habit: Habit; membership: Membership }[];
  /** Oldest first. */
  periods: TowerPeriod[];
  entries: Entry[];
  /** Oldest first: blocks[0] is ordinal 1. */
  blocks: BaseBlock[];
};

/**
 * Writes a scenario plan, in one transaction.
 *
 * RAW INSERTS, ON PURPOSE. A plan carries columns the services refuse to write:
 * tower lifecycle, started_at, height and current_streak; membership state and
 * counters; period state and outcome; entries' local_date. That refusal is
 * right for application code and is exactly what a fixture has to get round.
 * Each row is typed as the table's $inferInsert, so a plan that drifts from the
 * schema fails typecheck here.
 *
 * Base blocks are the exception: they go through appendBaseBlock, oldest
 * first, so ordinals are allocated exactly as in production.
 *
 * Users already present (shared across plans) are left as they are.
 */
export async function persist(db: Db, plan: ScenarioPlan): Promise<Scenario> {
  if (plan.tower && !isValidTimeZone(plan.tower.timezone)) {
    throw new InvalidTimeZoneError(plan.tower.timezone);
  }

  return db.transaction(async (tx) => {
    const userIds = plan.users.map((u) => u.id);
    if (plan.users.length) {
      await tx
        .insert(users)
        .values(
          plan.users.map((u): typeof users.$inferInsert => ({
            id: u.id,
            email: u.email,
            passwordHash: u.passwordHash,
            displayName: u.displayName,
          }))
        )
        .onConflictDoNothing({ target: users.id });
    }
    const userRows = userIds.length
      ? await tx.select().from(users).where(inArray(users.id, userIds))
      : [];

    const habitRows = plan.habits.length
      ? await tx
          .insert(habits)
          .values(
            plan.habits.map((h): typeof habits.$inferInsert => ({
              id: h.id,
              ownerId: h.ownerId,
              name: h.name,
              type: h.type,
              unit: h.unit,
              lifecycle: h.lifecycle,
              startedAt: h.startedAt,
            }))
          )
          .returning()
      : [];
    const tierRows = plan.habits.flatMap((h) =>
      h.tiers.map((t): typeof habitTiers.$inferInsert => ({ ...t, habitId: h.id }))
    );
    if (tierRows.length) await tx.insert(habitTiers).values(tierRows);

    let towerRow: Tower | null = null;
    if (plan.tower) {
      const t = plan.tower;
      const [row] = await tx
        .insert(towers)
        .values({
          id: t.id,
          hostId: t.hostId,
          name: t.name,
          deadlineTime: t.deadlineTime,
          timezone: t.timezone,
          graceWindowMinutes: t.graceWindowMinutes,
          lifecycle: t.lifecycle,
          startedAt: t.startedAt,
          height: t.height,
          currentStreak: t.currentStreak,
          joinCode: generateJoinCode(),
        } satisfies typeof towers.$inferInsert)
        .returning();
      towerRow = row!;
    }

    const membershipRows = plan.memberships.length
      ? await tx
          .insert(memberships)
          .values(plan.memberships.map((m): typeof memberships.$inferInsert => ({ ...m })))
          .returning()
      : [];

    const periodRows = plan.periods.length
      ? await tx
          .insert(towerPeriods)
          .values(plan.periods.map((p): typeof towerPeriods.$inferInsert => ({ ...p })))
          .returning()
      : [];

    const entryRows = plan.entries.length
      ? await tx
          .insert(entries)
          .values(plan.entries.map((e): typeof entries.$inferInsert => ({ ...e })))
          .returning()
      : [];

    const blockRows: BaseBlock[] = [];
    for (const b of plan.blocks) blockRows.push(await appendBaseBlock(tx, b));

    const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
    const usersById = byId(userRows);
    const habitsById = byId(habitRows);
    const membershipsById = byId(membershipRows);

    return {
      plan,
      now: plan.now,
      users: plan.users.map((u) => usersById.get(u.id)!),
      habits: habitRows,
      tower: towerRow,
      members: plan.members.map((m) => ({
        user: usersById.get(m.user.id)!,
        habit: habitsById.get(m.habit.id)!,
        membership: membershipsById.get(m.membership.id)!,
      })),
      periods: periodRows.sort((a, b) => a.periodStart.localeCompare(b.periodStart)),
      entries: entryRows,
      blocks: blockRows,
    };
  });
}
