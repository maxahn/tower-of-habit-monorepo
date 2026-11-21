import {
  activateTower,
  createMembership,
  createPeriod,
  createTowerWithFreshCode,
  deleteMembership,
  deleteTower,
  findTowerByJoinCode,
  getHabit,
  getMembership,
  JoinCodeExhaustedError,
  listPeriodsForTower,
  listTowerMembers,
  listTowersForUser,
  transitionMembership,
  updateMembership,
} from '@tower-of-habit/db';
import {
  addDays,
  createTowerRequestSchema,
  daysBetween,
  declareAbsenceRequestSchema,
  joinTowerRequestSchema,
  type PeriodPreviewResponse,
  type TowerListResponse,
} from '@tower-of-habit/shared';
import { evaluatePeriod } from '@tower-of-habit/shared/evaluator';
import { loadEvaluationInput } from '../evaluation/input.js';
import type { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import { withTx, type TxRunner } from '../context.js';
import { DomainError } from '../errors.js';
import type { ClientIpResolver } from '../rate-limit/client-ip.js';
import { enforceRateLimits, type RateLimitDeps } from '../rate-limit/enforce.js';
import type { RateRule } from '../rate-limit/limiter.js';
import { jsonBody } from '../validation.js';
import { firstPeriodStart, periodInsert, periodWindowFor } from './periods.js';
import { bindableHabit, memberOf, towerDetail } from './service.js';

/**
 * 2.13: tower creation and the lobby.
 *   POST /towers       create in lobby (draft) with the creator's membership
 *   GET  /towers       the caller's towers
 *   GET  /towers/:id   member-only detail; lobby and active shapes differ
 *
 * 2.14: join, leave, remove.
 *   POST   /towers/join                              by code, in the lobby only
 *   DELETE /towers/:id/memberships/:membershipId     self in the lobby; others
 *                                                    by the creator only
 *
 * 2.15: POST /towers/:id/start — creator only, >= 2 members, lobby -> active
 * with period 1 materialised in the same transaction. Idempotent on an active
 * tower.
 *
 * 2.17: GET /towers/:id/period — the current period through evaluatePeriod
 * with ctx.now. Read-only: even a computed `collapsed` writes nothing; that is
 * the evaluation job's (2.19).
 *
 * Non-members get 404, never 403: a 403 would confirm the id (or code) is real.
 * An unknown code and a non-joinable tower take the same single lookup, so
 * timing does not distinguish them.
 */

export type TowerRouteDeps = {
  db: TxRunner;
  rateLimit: RateLimitDeps & { clientIp: ClientIpResolver };
};

/**
 * 2.18: join-by-code limits. An 8-character code space is plenty against
 * random guessing but not against a patient enumerator; the per-user limit is
 * the real control and the per-IP one catches the rest. Every attempt counts,
 * and both fail closed: with the limiter down the endpoint refuses (503).
 */
const HOUR_SECONDS = 60 * 60;
export const JOIN_PER_USER: RateRule = {
  name: 'join:user',
  limit: 10,
  windowSeconds: HOUR_SECONDS,
};
export const JOIN_PER_IP: RateRule = { name: 'join:ip', limit: 30, windowSeconds: HOUR_SECONDS };

export function mountTowerRoutes(api: Hono<AppEnv>, deps: TowerRouteDeps): void {
  api.post('/towers', jsonBody(createTowerRequestSchema), (c) =>
    withTx(deps.db, c, async (tx, ctx) => {
      const { habitId, ...body } = c.req.valid('json');
      const shape = { periodUnit: body.periodUnit ?? 'day', periodLength: body.periodLength ?? 1 };
      const habit = await bindableHabit(tx, ctx, habitId, shape);
      let tower;
      try {
        tower = await createTowerWithFreshCode(tx, {
          hostId: ctx.userId,
          name: body.name,
          deadlineTime: body.deadlineTime,
          timezone: body.timezone,
          graceWindowMinutes: body.graceWindowMinutes,
          wobbleLeadMinutes: body.wobbleLeadMinutes,
          ...(body.periodUnit !== undefined ? { periodUnit: body.periodUnit } : {}),
          ...(body.periodLength !== undefined ? { periodLength: body.periodLength } : {}),
          ...(body.quota !== undefined ? { quota: body.quota } : {}),
          ...(body.weekResetDay !== undefined ? { weekResetDay: body.weekResetDay } : {}),
          ...(body.nudgeLeadMinutes !== undefined
            ? { nudgeLeadMinutes: body.nudgeLeadMinutes }
            : {}),
        });
      } catch (e) {
        if (e instanceof JoinCodeExhaustedError) {
          throw new DomainError(503, 'join_code_unavailable', 'Could not allocate a join code');
        }
        throw e;
      }
      await createMembership(tx, {
        towerId: tower.id,
        userId: ctx.userId,
        habitId: habit.id,
        joinedAt: ctx.now,
      });
      return c.json(await towerDetail(tx, ctx, tower), 201);
    })
  );

  api.get('/towers', (c) =>
    withTx(deps.db, c, async (tx, ctx) => {
      const rows = await listTowersForUser(tx, ctx.userId);
      const body: TowerListResponse = {
        towers: rows.map(({ tower, membershipState, memberCount }) => {
          const { joinCode: _code, ...rest } = tower;
          void _code;
          return {
            tower: rest as unknown as TowerListResponse['towers'][number]['tower'],
            membershipState,
            memberCount,
          };
        }),
      };
      return c.json(body);
    })
  );

  api.post('/towers/join', jsonBody(joinTowerRequestSchema), async (c) => {
    await enforceRateLimits(
      deps.rateLimit,
      [
        { rule: JOIN_PER_USER, id: c.get('userId') },
        { rule: JOIN_PER_IP, id: deps.rateLimit.clientIp(c) },
      ],
      { failClosed: true }
    );
    return withTx(deps.db, c, async (tx, ctx) => {
      const { joinCode, habitId } = c.req.valid('json');
      const tower = await findTowerByJoinCode(tx, joinCode);
      if (!tower) throw new DomainError(404, 'not_found', 'Tower not found');
      if (tower.lifecycle !== 'draft') {
        throw new DomainError(409, 'tower_not_joinable', 'The tower is no longer in its lobby');
      }
      const roster = await listTowerMembers(tx, tower.id);
      if (roster.some((m) => m.userId === ctx.userId)) {
        throw new DomainError(409, 'already_member', 'You are already in this tower');
      }
      const habit = await bindableHabit(tx, ctx, habitId, tower);
      await createMembership(tx, {
        towerId: tower.id,
        userId: ctx.userId,
        habitId: habit.id,
        joinedAt: ctx.now,
      });
      return c.json(await towerDetail(tx, ctx, tower), 201);
    });
  });

  api.delete('/towers/:id/memberships/:membershipId', (c) =>
    withTx(deps.db, c, async (tx, ctx) => {
      const { tower, membership: mine } = await memberOf(tx, ctx, c.req.param('id'));
      const target = await getMembership(tx, c.req.param('membershipId'));
      if (!target || target.towerId !== tower.id || target.state === 'removed') {
        throw new DomainError(404, 'not_found', 'Membership not found');
      }
      if (tower.lifecycle !== 'draft') {
        // Leaving a running tower is voluntary dormancy, which is Phase 3.
        throw new DomainError(409, 'tower_not_in_lobby', 'Members can only leave in the lobby');
      }
      const isCreator = tower.hostId === ctx.userId;
      const isSelf = target.id === mine.id;
      if (!isSelf && !isCreator) {
        throw new DomainError(403, 'forbidden', 'Only the creator can remove other members');
      }
      if (isSelf && isCreator) {
        const roster = await listTowerMembers(tx, tower.id);
        if (roster.length > 1) {
          throw new DomainError(
            409,
            'creator_cannot_leave',
            'The creator cannot leave while others remain; remove them first to disband'
          );
        }
        // Alone: leaving disbands the lobby (memberships cascade).
        await deleteTower(tx, tower.id);
        return c.body(null, 204);
      }
      // In the lobby the row is deleted outright, which frees the habit.
      await deleteMembership(tx, target.id);
      return c.body(null, 204);
    })
  );

  api.post('/towers/:id/start', (c) =>
    withTx(deps.db, c, async (tx, ctx) => {
      const { tower } = await memberOf(tx, ctx, c.req.param('id'));
      if (tower.hostId !== ctx.userId) {
        throw new DomainError(403, 'forbidden', 'Only the creator can start the tower');
      }
      // Idempotent: an active tower returns its state, with no second period.
      if (tower.lifecycle !== 'draft') return c.json(await towerDetail(tx, ctx, tower));

      const roster = await listTowerMembers(tx, tower.id);
      if (roster.length < 2) {
        throw new DomainError(409, 'tower_too_small', 'A tower needs at least two members');
      }
      for (const m of roster) {
        const habit = await getHabit(tx, m.habitId);
        if (
          !habit ||
          habit.periodUnit !== tower.periodUnit ||
          habit.periodLength !== tower.periodLength
        ) {
          throw new DomainError(
            409,
            'habit_cadence_mismatch',
            "Every member's habit must match the tower's cadence"
          );
        }
      }
      const started = await activateTower(tx, tower.id, ctx.now);
      if (!started) return c.json(await towerDetail(tx, ctx, tower)); // raced; see above
      // Period 1, in this transaction: an active tower is never without one.
      await createPeriod(
        tx,
        periodInsert(tower.id, periodWindowFor(tower, firstPeriodStart(tower, ctx.now)))
      );
      return c.json(await towerDetail(tx, ctx, started));
    })
  );

  api.get('/towers/:id/period', (c) =>
    withTx(deps.db, c, async (tx, ctx) => {
      const { tower } = await memberOf(tx, ctx, c.req.param('id'));
      if (tower.lifecycle === 'draft') {
        throw new DomainError(409, 'tower_not_started', 'The tower has not started');
      }
      const [period] = await listPeriodsForTower(tx, tower.id, 1);
      if (!period) {
        throw new DomainError(409, 'tower_not_started', 'The tower has no period');
      }
      const loaded = await loadEvaluationInput(tx, tower, period, ctx.now);
      const out = evaluatePeriod(loaded.input);
      const body: PeriodPreviewResponse = {
        period: period as unknown as PeriodPreviewResponse['period'],
        window: loaded.window,
        now: ctx.now.toISOString(),
        periodStatus: out.periodStatus,
        quota: tower.quota,
        members: loaded.memberships.map((m, i) => {
          const o = out.perMember[i]!;
          return {
            membershipId: m.id,
            userId: m.userId,
            displayName: loaded.names.get(m.id) ?? null,
            state: m.state,
            qualifyingDays: loaded.input.members[i]!.qualifyingDays,
            standing: o.standing,
            daysNeeded: o.daysNeeded,
            daysRemaining: o.daysRemaining,
            slack: o.slack,
          };
        }),
        outstanding:
          out.periodStatus === 'wobbling'
            ? out.perMember.filter((o) => o.standing === 'short').map((o) => o.membershipId)
            : [],
        height: tower.height,
        currentStreak: tower.currentStreak,
        soloActive:
          loaded.memberships.filter((m) => m.state === 'active' || m.state === 'at_risk').length ===
          1,
      };
      return c.json(body);
    })
  );

  api.post('/towers/:id/absence', jsonBody(declareAbsenceRequestSchema), (c) =>
    withTx(deps.db, c, async (tx, ctx) => {
      const { tower, membership } = await memberOf(tx, ctx, c.req.param('id'));
      if (tower.lifecycle === 'draft') {
        throw new DomainError(409, 'tower_not_started', 'The tower has not started');
      }
      const { from, to } = c.req.valid('json');
      if (from > to) {
        throw new DomainError(400, 'invalid_date_range', 'from must not be after to');
      }
      const days = daysBetween(from, to) + 1;
      if (days > 14) {
        throw new DomainError(409, 'absence_too_long', 'A single absence cannot exceed 14 days');
      }
      if (membership.voluntaryReturnDate !== null) {
        throw new DomainError(409, 'absence_already_active', 'You already have an active absence');
      }
      if (membership.voluntaryAbsenceDaysUsed + days > 28) {
        throw new DomainError(
          409,
          'annual_budget_exceeded',
          'Your annual absence budget of 28 days would be exceeded'
        );
      }
      const voluntaryReturnDate = addDays(to, 1);
      const [period] = await listPeriodsForTower(tx, tower.id, 1);
      const afterDeadline =
        period !== undefined &&
        ctx.now.getTime() >= Date.parse(periodWindowFor(tower, period.periodStart).deadlineAt);
      if (!afterDeadline) {
        await transitionMembership(
          tx,
          membership.id,
          { to: 'dormant', reason: 'voluntary' },
          ctx.now
        );
      }
      await updateMembership(tx, membership.id, {
        voluntaryReturnDate,
        voluntaryAbsenceDaysUsed: membership.voluntaryAbsenceDaysUsed + days,
      });
      return c.json({ from, to });
    })
  );

  api.delete('/towers/:id/absence', (c) =>
    withTx(deps.db, c, async (tx, ctx) => {
      const { tower, membership } = await memberOf(tx, ctx, c.req.param('id'));
      if (tower.lifecycle === 'draft') {
        throw new DomainError(409, 'tower_not_started', 'The tower has not started');
      }
      if (membership.voluntaryReturnDate === null) {
        throw new DomainError(409, 'no_active_absence', 'You have no active absence to cancel');
      }
      if (membership.state === 'dormant' && membership.dormancyReason === 'voluntary') {
        await transitionMembership(tx, membership.id, { to: 'active' }, ctx.now);
      }
      await updateMembership(tx, membership.id, { voluntaryReturnDate: null });
      return c.body(null, 204);
    })
  );

  api.get('/towers/:id', (c) =>
    withTx(deps.db, c, async (tx, ctx) => {
      const { tower } = await memberOf(tx, ctx, c.req.param('id'));
      return c.json(await towerDetail(tx, ctx, tower));
    })
  );
}
