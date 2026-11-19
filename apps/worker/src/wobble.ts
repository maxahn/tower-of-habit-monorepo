import {
  countQualifyingDays,
  ensureNotification,
  getPeriod,
  getTower,
  listMembershipsForTower,
  type Db,
} from '@tower-of-habit/db';

export async function processWobble(db: Db, periodId: string, now: Date): Promise<number> {
  const period = await getPeriod(db, periodId);
  if (!period || period.state !== 'pending') return 0;
  if (now > period.deadlineAt) return 0;

  const tower = await getTower(db, period.towerId);
  if (!tower) return 0;

  const allMembers = await listMembershipsForTower(db, tower.id);
  const live = allMembers.filter((m) => m.state === 'active' || m.state === 'at_risk');

  let anyOutstanding = false;
  for (const m of live) {
    const days = await countQualifyingDays(db, m.habitId, period.periodStart, period.periodEnd);
    if (days < tower.quota) {
      anyOutstanding = true;
      break;
    }
  }

  if (!anyOutstanding) return 0;

  let count = 0;
  for (const m of live) {
    await ensureNotification(db, {
      userId: m.userId,
      towerId: tower.id,
      scheduledFor: now,
      event: { type: 'wobble', periodId, userId: m.userId },
    });
    count++;
  }

  return count;
}
