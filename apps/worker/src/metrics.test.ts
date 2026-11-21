import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@tower-of-habit/db';
import { collectAndLogMetrics, failedJobCount, type MetricsDeps } from './metrics.js';

const fakeDb = {} as Db;
const NOW = new Date('2026-01-15T22:00:00Z');

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('failedJobCount', () => {
  it('returns a number (not throwing)', async () => {
    const count = await failedJobCount(fakeDb);
    expect(typeof count).toBe('number');
    expect(count).toBeGreaterThanOrEqual(0);
  });
});

describe('collectAndLogMetrics', () => {
  it('returns TickMetrics with both fields', async () => {
    const deps: MetricsDeps = {
      oldestPendingPeriodAge: vi.fn().mockResolvedValue(120),
      failedJobCount: vi.fn().mockResolvedValue(3),
      logger: makeLogger(),
    };

    const metrics = await collectAndLogMetrics(fakeDb, NOW, deps);

    expect(metrics).toEqual({
      oldestPendingAge: 120,
      failedJobCount: 3,
    });
  });

  it('logs a warning when oldestPendingAge exceeds 15 minutes', async () => {
    const logger = makeLogger();
    const deps: MetricsDeps = {
      oldestPendingPeriodAge: vi.fn().mockResolvedValue(901),
      failedJobCount: vi.fn().mockResolvedValue(0),
      logger,
    };

    await collectAndLogMetrics(fakeDb, NOW, deps);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ oldestPendingAge: 901 }),
      expect.stringContaining('oldest pending period')
    );
  });

  it('logs a warning when failedJobCount is greater than 0', async () => {
    const logger = makeLogger();
    const deps: MetricsDeps = {
      oldestPendingPeriodAge: vi.fn().mockResolvedValue(null),
      failedJobCount: vi.fn().mockResolvedValue(5),
      logger,
    };

    await collectAndLogMetrics(fakeDb, NOW, deps);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ failedJobCount: 5 }),
      expect.stringContaining('failed')
    );
  });
});
