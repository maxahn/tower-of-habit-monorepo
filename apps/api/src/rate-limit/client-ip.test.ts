import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createClientIpResolver, type ClientIpResolver } from './client-ip.js';

function echo(resolve: ClientIpResolver) {
  const app = new Hono();
  app.get('/', (c) => c.json({ ip: resolve(c) }));
  return async (headers: Record<string, string> = {}) =>
    ((await (await app.request('/', { headers })).json()) as { ip: string | null }).ip;
}

describe('createClientIpResolver', () => {
  it('reads the trusted header when configured (case-insensitive, trimmed)', async () => {
    const ip = echo(createClientIpResolver({ trustedHeader: 'X-Real-IP' }));
    expect(await ip({ 'x-real-ip': ' 203.0.113.7 ' })).toBe('203.0.113.7');
  });

  it('returns null when the trusted header is configured but missing', async () => {
    const ip = echo(createClientIpResolver({ trustedHeader: 'x-real-ip' }));
    expect(await ip()).toBeNull();
  });

  it('ignores the header when not configured, falling back to the socket (none in tests → null)', async () => {
    const ip = echo(createClientIpResolver());
    expect(await ip({ 'x-real-ip': '203.0.113.7' })).toBeNull();
  });

  it('treats an empty trustedHeader as not configured', async () => {
    const ip = echo(createClientIpResolver({ trustedHeader: '' }));
    expect(await ip({ 'x-real-ip': '203.0.113.7' })).toBeNull();
  });
});
