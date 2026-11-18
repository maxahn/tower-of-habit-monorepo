import type { Db, Membership, PeriodOutcome, TowerPeriod } from '@tower-of-habit/db';
import type { MembershipTransition } from '@tower-of-habit/shared/evaluator';

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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  tx: Db,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  params: EnqueueNotificationsParams
): Promise<number> {
  return 0;
}
