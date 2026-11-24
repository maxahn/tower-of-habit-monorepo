import {
  countQualifyingDays,
  ensureNotification,
  getPeriod,
  getTower,
  listMembershipsForTower,
  type Db,
} from '@tower-of-habit/db';

export type NotificationKind = 'nudge' | 'wobble';

export async function dispatchPeriodNotifications(
  db: Db,
  periodId: string,
  now: Date,
  kind: NotificationKind
): Promise<number> {
  const period = await getPeriod(db, periodId);
  if (!period || period.state !== 'pending') return 0;
  if (now > period.deadlineAt) return 0;

  const tower = await getTower(db, period.towerId);
  if (!tower) return 0;

  const allMembers = await listMembershipsForTower(db, tower.id);
  const live = allMembers.filter((m) => m.state === 'active' || m.state === 'at_risk');

  const quotaByMember = new Map<string, number>();
  for (const m of live) {
    const days = await countQualifyingDays(db, m.habitId, period.periodStart, period.periodEnd);
    quotaByMember.set(m.id, days);
  }

  if (kind === 'wobble') {
    const anyOutstanding = live.some((m) => quotaByMember.get(m.id)! < tower.quota);
    if (!anyOutstanding) return 0;
  }

  let count = 0;
  for (const m of live) {
    if (kind === 'nudge' && quotaByMember.get(m.id)! >= tower.quota) continue;

    await ensureNotification(db, {
      userId: m.userId,
      towerId: tower.id,
      scheduledFor: now,
      event: { type: kind, periodId, userId: m.userId },
    });
    count++;
  }

  return count;
}
