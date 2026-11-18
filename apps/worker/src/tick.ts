import type { Logger } from './logger.js';

export type TickReport = {
  claimed: number;
  evaluated: number;
  skipped: number;
  errored: number;
  durationMs: number;
};

export type EvaluateFn = (towerId: string, periodId: string, now: Date) => Promise<unknown>;

export type ClaimFn = (now: Date) => Promise<ReadonlyArray<{ towerId: string; id: string }>>;

export type TickDeps = {
  claim: ClaimFn;
  evaluate: EvaluateFn;
  logger: Logger;
};

export async function runTick(now: Date, deps: TickDeps): Promise<TickReport> {
  const start = performance.now();
  const report: TickReport = {
    claimed: 0,
    evaluated: 0,
    skipped: 0,
    errored: 0,
    durationMs: 0,
  };

  const periods = await deps.claim(now);
  report.claimed = periods.length;

  for (const period of periods) {
    try {
      await deps.evaluate(period.towerId, period.id, now);
      report.evaluated++;
    } catch (err) {
      report.errored++;
      deps.logger.error(
        { err, towerId: period.towerId, periodId: period.id },
        'period evaluation failed'
      );
    }
  }

  report.durationMs = Math.round((performance.now() - start) * 100) / 100;
  return report;
}
