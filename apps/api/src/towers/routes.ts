import {
  createMembership,
  createTowerWithFreshCode,
  deleteMembership,
  deleteTower,
  findTowerByJoinCode,
  getMembership,
  JoinCodeExhaustedError,
  listTowerMembers,
  listTowersForUser,
} from '@tower-of-habit/db';
import {
  createTowerRequestSchema,
  joinTowerRequestSchema,
  type TowerListResponse,
} from '@tower-of-habit/shared';
import type { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import { withTx, type TxRunner } from '../context.js';
import { DomainError } from '../errors.js';
import { jsonBody } from '../validation.js';
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
 * Non-members get 404, never 403: a 403 would confirm the id (or code) is real.
 * An unknown code and a non-joinable tower take the same single lookup, so
 * timing does not distinguish them.
 */

export type TowerRouteDeps = { db: TxRunner };

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
      await createMembership(tx, { towerId: tower.id, userId: ctx.userId, habitId: habit.id });
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

  api.post('/towers/join', jsonBody(joinTowerRequestSchema), (c) =>
    withTx(deps.db, c, async (tx, ctx) => {
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
      await createMembership(tx, { towerId: tower.id, userId: ctx.userId, habitId: habit.id });
      return c.json(await towerDetail(tx, ctx, tower), 201);
    })
  );

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

  api.get('/towers/:id', (c) =>
    withTx(deps.db, c, async (tx, ctx) => {
      const { tower } = await memberOf(tx, ctx, c.req.param('id'));
      return c.json(await towerDetail(tx, ctx, tower));
    })
  );
}
