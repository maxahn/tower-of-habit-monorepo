import {
  ensureNotification,
  memberships,
  towers,
  transitionMembership,
  type Db,
} from '@tower-of-habit/db';
import { civilInZone } from '@tower-of-habit/shared';
import { backstopDue, type MembershipSnapshot } from '@tower-of-habit/shared/evaluator';
import { eq, inArray } from 'drizzle-orm';

export async function sweepBackstop(db: Db, now: Date): Promise<number> {
  const rows = await db
    .select({
      id: memberships.id,
      towerId: memberships.towerId,
      userId: memberships.userId,
      state: memberships.state,
      dormancyReason: memberships.dormancyReason,
      consecutiveMissedPeriods: memberships.consecutiveMissedPeriods,
      lastQualifyingDate: memberships.lastQualifyingDate,
      joinedAt: memberships.joinedAt,
      voluntaryReturnDate: memberships.voluntaryReturnDate,
      timezone: towers.timezone,
    })
    .from(memberships)
    .innerJoin(towers, eq(memberships.towerId, towers.id))
    .where(inArray(memberships.state, ['active', 'at_risk']));

  let count = 0;
  for (const row of rows) {
    const today = civilInZone(now, row.timezone).date;
    const joinedOn = civilInZone(row.joinedAt, row.timezone).date;

    const snapshot: MembershipSnapshot = {
      membershipId: row.id,
      state: row.state,
      dormancyReason: row.dormancyReason,
      consecutiveMisses: row.consecutiveMissedPeriods,
      lastQualifyingDate: row.lastQualifyingDate,
      joinedOn,
      voluntaryReturnDate: row.voluntaryReturnDate,
    };

    if (!backstopDue(snapshot, today)) continue;

    await transitionMembership(db, row.id, { to: 'dormant', reason: 'backstop' }, now);
    await ensureNotification(db, {
      userId: row.userId,
      towerId: row.towerId,
      scheduledFor: now,
      event: { type: 'dormant', membershipId: row.id },
    });
    count++;
  }

  return count;
}
