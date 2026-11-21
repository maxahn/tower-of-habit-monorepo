import {
  createHabit,
  findHabitTower,
  getHabit,
  getUser,
  IllegalTransitionError,
  listHabitsForOwner,
  listQualifyingDates,
  listTiers,
  replaceTiers,
  transitionHabit,
  updateHabit,
  type Db,
  type Habit,
  type HabitTower,
} from '@tower-of-habit/db';
import {
  createHabitRequestSchema,
  replaceTiersRequestSchema,
  tierLadderIssues,
  updateHabitRequestSchema,
  civilInZone,
  type HabitDetailResponse,
  type HabitListResponse,
} from '@tower-of-habit/shared';
import { currentStreak } from '@tower-of-habit/shared/evaluator';
import type { Context, Hono } from 'hono';
import type { AppEnv } from '../app.js';
import { withTx, type RequestCtx, type TxRunner } from '../context.js';
import { DomainError } from '../errors.js';
import { jsonBody } from '../validation.js';

/**
 * 2.12: habits and tiers.
 *   POST /habits               create (active at once), 201 with the detail
 *   GET  /habits               the caller's habits
 *   GET  /habits/:id           detail: habit, ladder, current streak, tower
 *   PATCH /habits/:id          name / unit / cadence
 *   PUT  /habits/:id/tiers     replace the ladder wholesale
 *   POST /habits/:id/archive   archive (idempotent)
 *
 * Another user's habit is 404, never 403. The load-bearing rule: while the
 * habit is bound into an ACTIVE tower, its cadence and tier 0's threshold are
 * locked (409 habit_locked_by_tower); tiers above 0 stay editable, since the
 * tower only ever checks tier 0.
 */

export type HabitRouteDeps = { db: TxRunner };

/** How many qualifying dates the streak read fetches. A longer streak reads as this. */
const STREAK_WINDOW = 400;

const CADENCE_KEYS = ['periodUnit', 'periodLength', 'quota'] as const;

function locked(message: string): DomainError {
  return new DomainError(409, 'habit_locked_by_tower', message);
}

function validationFailed(details: Record<string, string[]>): DomainError {
  return new DomainError(400, 'validation_failed', 'Request validation failed', details);
}

async function ownHabit(tx: Db, ctx: RequestCtx, id: string): Promise<Habit> {
  const habit = await getHabit(tx, id);
  if (!habit || habit.ownerId !== ctx.userId) {
    throw new DomainError(404, 'not_found', 'Habit not found');
  }
  return habit;
}

/** The day boundary for the streak: the tower's zone when bound, the user's otherwise (D3). */
function todayFor(ctx: RequestCtx, bound: HabitTower | undefined, userTimezone: string): string {
  return civilInZone(ctx.now, bound ? bound.tower.timezone : userTimezone).date;
}

async function detail(
  tx: Db,
  ctx: RequestCtx,
  habit: Habit,
  userTimezone: string
): Promise<HabitDetailResponse> {
  const bound = await findHabitTower(tx, habit.id);
  const tiers = await listTiers(tx, habit.id);
  const dates = await listQualifyingDates(tx, habit.id, STREAK_WINDOW);
  return {
    habit: habit as unknown as HabitDetailResponse['habit'],
    tiers,
    currentStreak: currentStreak(dates, todayFor(ctx, bound, userTimezone)),
    tower: bound
      ? {
          id: bound.tower.id,
          name: bound.tower.name,
          lifecycle: bound.tower.lifecycle,
          membershipState: bound.membership.state,
        }
      : null,
  };
}

async function userTimezone(tx: Db, ctx: RequestCtx): Promise<string> {
  return (await getUser(tx, ctx.userId))?.timezone ?? 'UTC';
}

function habitId(c: Context<AppEnv>): string {
  return c.req.param('id') ?? '';
}

export function mountHabitRoutes(api: Hono<AppEnv>, deps: HabitRouteDeps): void {
  api.post('/habits', jsonBody(createHabitRequestSchema), (c) =>
    withTx(deps.db, c, async (tx, ctx) => {
      const body = c.req.valid('json');
      const base = {
        ownerId: ctx.userId,
        name: body.name,
        ...(body.periodUnit !== undefined ? { periodUnit: body.periodUnit } : {}),
        ...(body.periodLength !== undefined ? { periodLength: body.periodLength } : {}),
        ...(body.quota !== undefined ? { quota: body.quota } : {}),
      };
      const created =
        body.type === 'binary'
          ? await createHabit(tx, { ...base, type: 'binary' })
          : body.type === 'numeric'
            ? await createHabit(tx, {
                ...base,
                type: 'numeric',
                unit: body.unit,
                tiers: body.tiers,
              })
            : await createHabit(tx, { ...base, type: 'tiered', tiers: body.tiers });
      // Phase 2 has no draft flow: a habit is loggable the moment it exists.
      const habit = await transitionHabit(tx, created.id, 'active', ctx.now);
      return c.json(await detail(tx, ctx, habit, await userTimezone(tx, ctx)), 201);
    })
  );

  api.get('/habits', (c) =>
    withTx(deps.db, c, async (tx, ctx) => {
      const habits = await listHabitsForOwner(tx, ctx.userId);
      const body: HabitListResponse = { habits: habits as unknown as HabitListResponse['habits'] };
      return c.json(body);
    })
  );

  api.get('/habits/:id', (c) =>
    withTx(deps.db, c, async (tx, ctx) => {
      const habit = await ownHabit(tx, ctx, habitId(c));
      return c.json(await detail(tx, ctx, habit, await userTimezone(tx, ctx)));
    })
  );

  api.patch('/habits/:id', jsonBody(updateHabitRequestSchema), (c) =>
    withTx(deps.db, c, async (tx, ctx) => {
      const habit = await ownHabit(tx, ctx, habitId(c));
      const patch = c.req.valid('json');
      const bound = await findHabitTower(tx, habit.id);
      if (bound?.tower.lifecycle === 'active' && CADENCE_KEYS.some((k) => patch[k] !== undefined)) {
        throw locked('Cadence cannot change while the habit is in an active tower');
      }
      if (patch.unit !== undefined && (habit.type === 'numeric') !== (patch.unit !== null)) {
        throw validationFailed({ unit: ['unit is set exactly on numeric habits'] });
      }
      // exactOptionalPropertyTypes: forward only the keys that were sent.
      const updated = await updateHabit(
        tx,
        habit.id,
        Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
      );
      return c.json(await detail(tx, ctx, updated, await userTimezone(tx, ctx)));
    })
  );

  api.put('/habits/:id/tiers', jsonBody(replaceTiersRequestSchema), (c) =>
    withTx(deps.db, c, async (tx, ctx) => {
      const habit = await ownHabit(tx, ctx, habitId(c));
      const { tiers } = c.req.valid('json');
      const issues = tierLadderIssues(habit.type, tiers);
      if (issues.length) {
        const details: Record<string, string[]> = {};
        for (const i of issues) (details[i.path] ??= []).push(i.message);
        throw validationFailed(details);
      }
      const bound = await findHabitTower(tx, habit.id);
      if (bound?.tower.lifecycle === 'active') {
        const current = (await listTiers(tx, habit.id)).find((t) => t.tierIndex === 0);
        const next = tiers.find((t) => t.tierIndex === 0);
        if (current && next && current.thresholdValue !== next.thresholdValue) {
          throw locked("Tier 0's threshold cannot change while the habit is in an active tower");
        }
      }
      await replaceTiers(tx, habit.id, tiers);
      return c.json(await detail(tx, ctx, habit, await userTimezone(tx, ctx)));
    })
  );

  api.post('/habits/:id/archive', (c) =>
    withTx(deps.db, c, async (tx, ctx) => {
      const habit = await ownHabit(tx, ctx, habitId(c));
      if (habit.lifecycle === 'archived') {
        return c.json(await detail(tx, ctx, habit, await userTimezone(tx, ctx)));
      }
      const bound = await findHabitTower(tx, habit.id);
      if (bound?.tower.lifecycle === 'active') {
        throw locked('A habit in an active tower cannot be archived');
      }
      let archived: Habit;
      try {
        archived = await transitionHabit(tx, habit.id, 'archived', ctx.now);
      } catch (e) {
        if (e instanceof IllegalTransitionError) {
          throw new DomainError(409, 'illegal_transition', e.message);
        }
        throw e;
      }
      return c.json(await detail(tx, ctx, archived, await userTimezone(tx, ctx)));
    })
  );
}
