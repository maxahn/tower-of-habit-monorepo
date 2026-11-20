import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHealthchecksHeartbeat } from './heartbeat.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createHealthchecksHeartbeat', () => {
  it('returns a HeartbeatService with a ping method', () => {
    const hb = createHealthchecksHeartbeat('https://hc-ping.com/abc');
    expect(typeof hb.ping).toBe('function');
  });

  it('ping() issues a GET to the configured URL', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('OK'));
    vi.stubGlobal('fetch', fetchSpy);

    const hb = createHealthchecksHeartbeat('https://hc-ping.com/test-uuid');
    await hb.ping();

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://hc-ping.com/test-uuid');
  });

  it('does not throw on a non-200 response (fire-and-forget)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('error', { status: 500 })));

    const hb = createHealthchecksHeartbeat('https://hc-ping.com/test-uuid');
    await expect(hb.ping()).resolves.toBeUndefined();
  });

  it('does not throw on a network error (fire-and-forget)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const hb = createHealthchecksHeartbeat('https://hc-ping.com/test-uuid');
    await expect(hb.ping()).resolves.toBeUndefined();
  });
});
