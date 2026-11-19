import {
  findHabitTower,
  getHabit,
  getTower,
  listBaseBlocksForTower,
  listPeriodsForTower,
  listTowerMembers,
  type Db,
  type Habit,
  type Membership,
  type Tower,
} from '@tower-of-habit/db';
import type {
  TowerActiveResponse,
  TowerDetailResponse,
  TowerLobbyResponse,
} from '@tower-of-habit/shared';
import { and, eq, ne } from 'drizzle-orm';
import { memberships } from '@tower-of-habit/db';
import type { RequestCtx } from '../context.js';
import { DomainError } from '../errors.js';

/**
 * Shared pieces of the tower endpoints (2.13–2.15, 2.17).
 */

export const notFound = (): DomainError => new DomainError(404, 'not_found', 'Tower not found');

/** The caller's live membership in the tower, or 404: a stranger never learns a tower exists. */
export async function memberOf(
  tx: Db,
  ctx: RequestCtx,
  towerId: string
): Promise<{ tower: Tower; membership: Membership }> {
  const tower = await getTower(tx, towerId);
  if (!tower) throw notFound();
  const [membership] = await tx
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.towerId, towerId),
        eq(memberships.userId, ctx.userId),
        ne(memberships.state, 'removed')
      )
    );
  if (!membership) throw notFound();
  return { tower, membership };
}

/**
 * A habit the caller may bind into a tower: owned, not archived, cadence
 * matching, and not already committed to another live tower.
 */
export async function bindableHabit(
  tx: Db,
  ctx: RequestCtx,
  habitId: string,
  tower: Pick<Tower, 'periodUnit' | 'periodLength'>
): Promise<Habit> {
  const habit = await getHabit(tx, habitId);
  if (!habit || habit.ownerId !== ctx.userId) {
    throw new DomainError(404, 'not_found', 'Habit not found');
  }
  if (habit.lifecycle === 'archived') {
    throw new DomainError(409, 'habit_archived', 'An archived habit cannot join a tower');
  }
  if (habit.periodUnit !== tower.periodUnit || habit.periodLength !== tower.periodLength) {
    throw new DomainError(
      409,
      'habit_cadence_mismatch',
      "The habit's cadence must equal the tower's"
    );
  }
  if (await findHabitTower(tx, habit.id)) {
    throw new DomainError(
      409,
      'habit_already_committed',
      'The habit is already bound to another tower'
    );
  }
  return habit;
}

/** GET /towers/:id body: the lobby shape for a draft tower, the active shape otherwise. */
export async function towerDetail(
  tx: Db,
  ctx: RequestCtx,
  tower: Tower
): Promise<TowerDetailResponse> {
  const members = (await listTowerMembers(
    tx,
    tower.id
  )) as unknown as TowerDetailResponse['members'];
  const role = tower.hostId === ctx.userId ? 'host' : 'member';
  if (tower.lifecycle === 'draft') {
    return {
      kind: 'lobby',
      tower: tower as unknown as TowerLobbyResponse['tower'],
      members,
      role,
      joinCode: tower.joinCode,
    };
  }
  const { joinCode: _code, ...rest } = tower;
  void _code;
  const [currentPeriod] = await listPeriodsForTower(tx, tower.id, 1);
  const blocks = await listBaseBlocksForTower(tx, tower.id);
  return {
    kind: 'active',
    tower: rest as unknown as TowerActiveResponse['tower'],
    members,
    role,
    currentPeriod: (currentPeriod ?? null) as unknown as TowerActiveResponse['currentPeriod'],
    blocks: blocks as unknown as TowerActiveResponse['blocks'],
    soloActive: false,
  };
}
