import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HeartbeatService } from './heartbeat.js';
import type { TickReport } from './tick.js';
import { startTickLoop } from './loop.js';

const ZERO_REPORT: TickReport = {
  materialised: 0,
  claimed: 0,
  evaluated: 0,
  skipped: 0,
  errored: 0,
  durationMs: 0,
};

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startTickLoop', () => {
  it('fires a tick shortly after starting', async () => {
    const tick = vi.fn<() => Promise<TickReport>>().mockResolvedValue(ZERO_REPORT);
    const loop = startTickLoop({ intervalMs: 1000, tick, logger: makeLogger() });

    await delay(50);
    await loop.stop();

    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('does not overlap — a slow tick blocks the next one', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const tick = vi.fn<() => Promise<TickReport>>().mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await delay(80);
      concurrent--;
      return ZERO_REPORT;
    });

    const loop = startTickLoop({ intervalMs: 10, tick, logger: makeLogger() });
    await delay(300);
    await loop.stop();

    expect(maxConcurrent).toBe(1);
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('continues after a tick throws', async () => {
    const tick = vi
      .fn<() => Promise<TickReport>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(ZERO_REPORT);

    const logger = makeLogger();
    const loop = startTickLoop({ intervalMs: 10, tick, logger });
    await delay(100);
    await loop.stop();

    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(logger.error).toHaveBeenCalled();
  });

  it('stop() awaits in-flight tick before resolving', async () => {
    let tickFinished = false;
    const tick = vi.fn<() => Promise<TickReport>>().mockImplementation(async () => {
      await delay(100);
      tickFinished = true;
      return ZERO_REPORT;
    });

    const loop = startTickLoop({ intervalMs: 10_000, tick, logger: makeLogger() });
    await delay(20);
    await loop.stop();

    expect(tickFinished).toBe(true);
  });

  it('no more ticks fire after stop()', async () => {
    const tick = vi.fn<() => Promise<TickReport>>().mockResolvedValue(ZERO_REPORT);
    const loop = startTickLoop({ intervalMs: 10, tick, logger: makeLogger() });

    await delay(50);
    await loop.stop();
    const countAfterStop = tick.mock.calls.length;

    await delay(100);
    expect(tick.mock.calls.length).toBe(countAfterStop);
  });
});

describe('tick loop — heartbeat and reporting (3.17)', () => {
  const REPORT: TickReport = {
    materialised: 2,
    claimed: 3,
    evaluated: 2,
    skipped: 1,
    errored: 0,
    durationMs: 42,
  };

  it('calls heartbeat.ping() after a successful tick', async () => {
    const heartbeat: HeartbeatService = { ping: vi.fn().mockResolvedValue(undefined) };
    const tick = vi.fn<() => Promise<TickReport>>().mockResolvedValue(REPORT);
    const loop = startTickLoop({
      intervalMs: 1000,
      tick,
      logger: makeLogger(),
      heartbeat,
    });

    await delay(50);
    await loop.stop();

    expect(heartbeat.ping).toHaveBeenCalledOnce();
  });

  it('does NOT call heartbeat.ping() when the tick throws', async () => {
    const heartbeat: HeartbeatService = { ping: vi.fn().mockResolvedValue(undefined) };
    const tick = vi
      .fn<() => Promise<TickReport>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(ZERO_REPORT);
    const loop = startTickLoop({
      intervalMs: 1000,
      tick,
      logger: makeLogger(),
      heartbeat,
    });

    await delay(50);
    await loop.stop();

    expect(heartbeat.ping).not.toHaveBeenCalled();
  });

  it('calls onSuccess with the TickReport after a successful tick', async () => {
    const onSuccess = vi.fn().mockResolvedValue(undefined);
    const tick = vi.fn<() => Promise<TickReport>>().mockResolvedValue(REPORT);
    const loop = startTickLoop({
      intervalMs: 1000,
      tick,
      logger: makeLogger(),
      onSuccess,
    });

    await delay(50);
    await loop.stop();

    expect(onSuccess).toHaveBeenCalledWith(REPORT);
  });

  it('does NOT call onSuccess when the tick throws', async () => {
    const onSuccess = vi.fn().mockResolvedValue(undefined);
    const tick = vi
      .fn<() => Promise<TickReport>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(ZERO_REPORT);
    const loop = startTickLoop({
      intervalMs: 1000,
      tick,
      logger: makeLogger(),
      onSuccess,
    });

    await delay(50);
    await loop.stop();

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('logs the full TickReport including materialised and skipped', async () => {
    const logger = makeLogger();
    const tick = vi.fn<() => Promise<TickReport>>().mockResolvedValue(REPORT);
    const loop = startTickLoop({ intervalMs: 1000, tick, logger });

    await delay(50);
    await loop.stop();

    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const tickLogs = infoCalls.filter((call) => call[1] === 'tick complete');
    expect(tickLogs).toHaveLength(1);
    expect(tickLogs[0]![0]).toMatchObject({
      materialised: 2,
      claimed: 3,
      evaluated: 2,
      skipped: 1,
      errored: 0,
      durationMs: 42,
    });
  });
});
