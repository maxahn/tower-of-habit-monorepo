import { describe, expect, it, vi } from 'vitest';
import type { TickDeps } from './tick.js';
import { runTick } from './tick.js';

const NOW = new Date('2026-01-15T22:00:00Z');

function period(id: string, towerId: string) {
  return { id, towerId };
}

function makeDeps(overrides: Partial<TickDeps> = {}): TickDeps {
  return {
    claim: vi.fn<TickDeps['claim']>().mockResolvedValue([]),
    evaluate: vi.fn<TickDeps['evaluate']>().mockResolvedValue(undefined),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

describe('runTick', () => {
  it('claims and evaluates all periods', async () => {
    const periods = [period('p1', 't1'), period('p2', 't2'), period('p3', 't3')];
    const deps = makeDeps({ claim: vi.fn<TickDeps['claim']>().mockResolvedValue(periods) });

    const report = await runTick(NOW, deps);

    expect(report.claimed).toBe(3);
    expect(report.evaluated).toBe(3);
    expect(report.errored).toBe(0);
    expect(deps.evaluate).toHaveBeenCalledTimes(3);
    expect(deps.evaluate).toHaveBeenCalledWith('t1', 'p1', NOW);
    expect(deps.evaluate).toHaveBeenCalledWith('t2', 'p2', NOW);
    expect(deps.evaluate).toHaveBeenCalledWith('t3', 'p3', NOW);
  });

  it('isolates errors — one failure does not stop other evaluations', async () => {
    const periods = [period('p1', 't1'), period('p2', 't2'), period('p3', 't3')];
    const evaluate = vi
      .fn<TickDeps['evaluate']>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    const deps = makeDeps({
      claim: vi.fn<TickDeps['claim']>().mockResolvedValue(periods),
      evaluate,
    });

    const report = await runTick(NOW, deps);

    expect(report.claimed).toBe(3);
    expect(report.evaluated).toBe(2);
    expect(report.errored).toBe(1);
    expect(evaluate).toHaveBeenCalledTimes(3);
  });

  it('returns zeros when nothing is claimed', async () => {
    const deps = makeDeps();
    const report = await runTick(NOW, deps);

    expect(report.claimed).toBe(0);
    expect(report.evaluated).toBe(0);
    expect(report.errored).toBe(0);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('passes now to both claim and evaluate', async () => {
    const claim = vi.fn<TickDeps['claim']>().mockResolvedValue([period('p1', 't1')]);
    const evaluate = vi.fn<TickDeps['evaluate']>().mockResolvedValue(undefined);
    const deps = makeDeps({ claim, evaluate });

    await runTick(NOW, deps);

    expect(claim).toHaveBeenCalledWith(NOW);
    expect(evaluate).toHaveBeenCalledWith('t1', 'p1', NOW);
  });

  it('records duration', async () => {
    const deps = makeDeps();
    const report = await runTick(NOW, deps);
    expect(typeof report.durationMs).toBe('number');
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('logs errors with towerId and periodId', async () => {
    const err = new Error('evaluation failed');
    const deps = makeDeps({
      claim: vi.fn<TickDeps['claim']>().mockResolvedValue([period('p1', 't1')]),
      evaluate: vi.fn<TickDeps['evaluate']>().mockRejectedValue(err),
    });

    await runTick(NOW, deps);

    expect(deps.logger.error).toHaveBeenCalledWith(
      { err, towerId: 't1', periodId: 'p1' },
      'period evaluation failed'
    );
  });
});

function domainError(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe('runTick — skip detection', () => {
  it('skips a period_already_evaluated as skipped, not errored', async () => {
    const deps = makeDeps({
      claim: vi.fn<TickDeps['claim']>().mockResolvedValue([period('p1', 't1')]),
      evaluate: vi
        .fn<TickDeps['evaluate']>()
        .mockRejectedValue(domainError('period_already_evaluated')),
    });

    const report = await runTick(NOW, deps);

    expect(report.skipped).toBe(1);
    expect(report.errored).toBe(0);
    expect(report.evaluated).toBe(0);
  });

  it('skips period_claimed', async () => {
    const deps = makeDeps({
      claim: vi.fn<TickDeps['claim']>().mockResolvedValue([period('p1', 't1')]),
      evaluate: vi.fn<TickDeps['evaluate']>().mockRejectedValue(domainError('period_claimed')),
    });

    const report = await runTick(NOW, deps);

    expect(report.skipped).toBe(1);
    expect(report.errored).toBe(0);
  });

  it('skips period_not_due', async () => {
    const deps = makeDeps({
      claim: vi.fn<TickDeps['claim']>().mockResolvedValue([period('p1', 't1')]),
      evaluate: vi.fn<TickDeps['evaluate']>().mockRejectedValue(domainError('period_not_due')),
    });

    const report = await runTick(NOW, deps);

    expect(report.skipped).toBe(1);
    expect(report.errored).toBe(0);
  });

  it('counts a plain Error (no code) as errored', async () => {
    const deps = makeDeps({
      claim: vi.fn<TickDeps['claim']>().mockResolvedValue([period('p1', 't1')]),
      evaluate: vi.fn<TickDeps['evaluate']>().mockRejectedValue(new Error('connection lost')),
    });

    const report = await runTick(NOW, deps);

    expect(report.errored).toBe(1);
    expect(report.skipped).toBe(0);
  });

  it('counts an unknown code as errored', async () => {
    const deps = makeDeps({
      claim: vi.fn<TickDeps['claim']>().mockResolvedValue([period('p1', 't1')]),
      evaluate: vi.fn<TickDeps['evaluate']>().mockRejectedValue(domainError('something_unknown')),
    });

    const report = await runTick(NOW, deps);

    expect(report.errored).toBe(1);
    expect(report.skipped).toBe(0);
  });
});
