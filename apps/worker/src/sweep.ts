import { ensurePeriod, towers, towerPeriods, type Db } from '@tower-of-habit/db';
import { addDays, civilInZone, resolvePeriodWindow } from '@tower-of-habit/shared';
import { and, eq, notExists, sql } from 'drizzle-orm';
import type { Logger } from './logger.js';

export async function materialisePeriods(db: Db, now: Date, logger: Logger): Promise<number> {
  const successor = db
    .select({ x: sql`1` })
    .from(towerPeriods)
    .where(and(eq(towerPeriods.towerId, towers.id), eq(towerPeriods.state, 'pending')));

  const candidates = await db
    .select({
      towerId: towers.id,
      periodUnit: towers.periodUnit,
      periodLength: towers.periodLength,
      weekResetDay: towers.weekResetDay,
      startedAt: towers.startedAt,
      timezone: towers.timezone,
      deadlineTime: towers.deadlineTime,
      graceWindowMinutes: towers.graceWindowMinutes,
      latestPeriodEnd: towerPeriods.periodEnd,
    })
    .from(towers)
    .innerJoin(
      towerPeriods,
      and(
        eq(towerPeriods.towerId, towers.id),
        eq(towerPeriods.state, 'evaluated'),
        eq(
          towerPeriods.periodStart,
          db
            .select({ maxStart: sql<string>`max(${towerPeriods.periodStart})` })
            .from(towerPeriods)
            .where(eq(towerPeriods.towerId, towers.id))
        )
      )
    )
    .where(and(eq(towers.lifecycle, 'active'), notExists(successor)));

  let count = 0;

  for (const c of candidates) {
    try {
      const nextStart = addDays(c.latestPeriodEnd, 1);
      const w = resolvePeriodWindow({
        periodUnit: c.periodUnit,
        periodLength: c.periodLength,
        weekResetDay: c.weekResetDay,
        anchorDate: civilInZone(c.startedAt!, c.timezone).date,
        on: nextStart,
        deadlineTime: c.deadlineTime,
        timeZone: c.timezone,
        graceMinutes: c.graceWindowMinutes,
      });

      await ensurePeriod(db, {
        towerId: c.towerId,
        periodStart: w.periodStart,
        periodEnd: w.periodEnd,
        deadlineAt: w.deadlineAt,
        evaluateAt: w.evaluateAt,
      });
      count++;
    } catch (err) {
      logger.error({ err, towerId: c.towerId }, 'failed to materialise period');
    }
  }

  return count;
}
