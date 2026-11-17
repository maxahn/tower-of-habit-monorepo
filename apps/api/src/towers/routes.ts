import {
  createMembership,
  createTowerWithFreshCode,
  JoinCodeExhaustedError,
  listTowersForUser,
} from '@tower-of-habit/db';
import { createTowerRequestSchema, type TowerListResponse } from '@tower-of-habit/shared';
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
 * Non-members get 404, never 403: a 403 would confirm the id (or code) is real.
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

  api.get('/towers/:id', (c) =>
    withTx(deps.db, c, async (tx, ctx) => {
      const { tower } = await memberOf(tx, ctx, c.req.param('id'));
      return c.json(await towerDetail(tx, ctx, tower));
    })
  );
}
