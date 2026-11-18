import {
  ensureNotification,
  type Db,
  type Membership,
  type PeriodOutcome,
  type TowerPeriod,
} from '@tower-of-habit/db';
import type { MembershipTransition } from '@tower-of-habit/shared/evaluator';
import type { NotificationEvent } from '@tower-of-habit/shared';

export type EnqueueNotificationsParams = {
  tower: { id: string };
  periodId: string;
  outcome: PeriodOutcome;
  memberships: Membership[];
  transitions: MembershipTransition[];
  periods: TowerPeriod[];
  now: Date;
};

export async function enqueueEvaluationNotifications(
  tx: Db,
  params: EnqueueNotificationsParams
): Promise<number> {
  const { tower, periodId, outcome, memberships, transitions, now } = params;

  if (outcome === 'survived') return 0;

  let count = 0;

  if (outcome === 'collapsed') {
    for (const m of memberships) {
      await ensure(tx, m.userId, tower.id, now, { type: 'collapse', periodId, userId: m.userId });
      count++;
    }
    for (const t of transitions) {
      if (t.type === 'at_risk') {
        await ensure(tx, userFor(t.membershipId, memberships), tower.id, now, {
          type: 'at_risk',
          membershipId: t.membershipId,
          periodId,
        });
        count++;
      } else if (t.type === 'dormant') {
        await ensure(tx, userFor(t.membershipId, memberships), tower.id, now, {
          type: 'dormant',
          membershipId: t.membershipId,
        });
        count++;
      }
    }
  } else if (outcome === 'hibernated') {
    const prev = previousPeriod(params.periods, periodId);
    if (prev?.outcome === 'hibernated') return 0;

    for (const m of memberships) {
      await ensure(tx, m.userId, tower.id, now, { type: 'hibernate', periodId, userId: m.userId });
      count++;
    }
  }

  return count;
}

function ensure(
  tx: Db,
  userId: string,
  towerId: string,
  scheduledFor: Date,
  event: NotificationEvent
) {
  return ensureNotification(tx, { userId, towerId, scheduledFor, event });
}

function userFor(membershipId: string, memberships: Membership[]): string {
  const m = memberships.find((mb) => mb.id === membershipId);
  if (!m) throw new Error(`membership ${membershipId} not found in loaded memberships`);
  return m.userId;
}

function previousPeriod(periods: TowerPeriod[], currentPeriodId: string): TowerPeriod | undefined {
  const idx = periods.findIndex((p) => p.id === currentPeriodId);
  return idx > 0 ? periods[idx - 1] : undefined;
}
