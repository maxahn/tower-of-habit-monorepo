import {
  listPeriodsForTower,
  transitionMembership,
  updateMembership,
  type Db,
} from '@tower-of-habit/db';
import { addDays, daysBetween } from '@tower-of-habit/shared';
import { DomainError } from '../errors.js';
import type { RequestCtx } from '../context.js';
import { periodWindowFor } from './periods.js';
import { memberOf } from './service.js';

export async function declareAbsence(
  tx: Db,
  ctx: RequestCtx,
  towerId: string,
  { from, to }: { from: string; to: string }
): Promise<{ from: string; to: string }> {
  const { tower, membership } = await memberOf(tx, ctx, towerId);
  if (tower.lifecycle === 'draft') {
    throw new DomainError(409, 'tower_not_started', 'The tower has not started');
  }
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
    await transitionMembership(tx, membership.id, { to: 'dormant', reason: 'voluntary' }, ctx.now);
  }
  await updateMembership(tx, membership.id, {
    voluntaryReturnDate,
    voluntaryAbsenceDaysUsed: membership.voluntaryAbsenceDaysUsed + days,
  });
  return { from, to };
}

export async function cancelAbsence(tx: Db, ctx: RequestCtx, towerId: string): Promise<void> {
  const { tower, membership } = await memberOf(tx, ctx, towerId);
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
}
