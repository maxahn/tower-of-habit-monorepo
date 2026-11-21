import type { Logger } from './logger.js';

const SKIP_CODES: ReadonlySet<string> = new Set([
  'period_already_evaluated',
  'period_claimed',
  'period_not_due',
]);

function isSkippable(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    typeof err.code === 'string' &&
    SKIP_CODES.has(err.code)
  );
}

export type TickReport = {
  materialised: number;
  claimed: number;
  evaluated: number;
  skipped: number;
  errored: number;
  durationMs: number;
};

export type EvaluateFn = (towerId: string, periodId: string, now: Date) => Promise<unknown>;

export type ClaimFn = (now: Date) => Promise<ReadonlyArray<{ towerId: string; id: string }>>;

export type MaterialiseFn = (now: Date) => Promise<number>;

export type TickDeps = {
  materialise?: MaterialiseFn;
  claim: ClaimFn;
  evaluate: EvaluateFn;
  logger: Logger;
};

export async function runTick(now: Date, deps: TickDeps): Promise<TickReport> {
  const start = performance.now();
  const report: TickReport = {
    materialised: 0,
    claimed: 0,
    evaluated: 0,
    skipped: 0,
    errored: 0,
    durationMs: 0,
  };

  if (deps.materialise) {
    report.materialised = await deps.materialise(now);
  }

  const periods = await deps.claim(now);
  report.claimed = periods.length;

  for (const period of periods) {
    try {
      const evalStart = performance.now();
      const result = await deps.evaluate(period.towerId, period.id, now);
      const evalMs = Math.round((performance.now() - evalStart) * 100) / 100;
      report.evaluated++;
      const outcome =
        result != null && typeof result === 'object' && 'outcome' in result
          ? (result as { outcome: string }).outcome
          : undefined;
      deps.logger.info(
        {
          towerId: period.towerId,
          periodId: period.id,
          durationMs: evalMs,
          ...(outcome != null ? { outcome } : {}),
        },
        'evaluation complete'
      );
    } catch (err) {
      if (isSkippable(err)) {
        report.skipped++;
        deps.logger.info(
          {
            towerId: period.towerId,
            periodId: period.id,
            code: (err as Error & { code: string }).code,
          },
          'period evaluation skipped'
        );
      } else {
        report.errored++;
        deps.logger.error(
          { err, towerId: period.towerId, periodId: period.id },
          'period evaluation failed'
        );
      }
    }
  }

  report.durationMs = Math.round((performance.now() - start) * 100) / 100;
  return report;
}
