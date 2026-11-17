import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

export type ClientIpResolver = (c: Context) => string | null;

/**
 * Resolves the client IP for per-IP rate limits.
 *
 * `trustedHeader` (prod: `x-real-ip`) is read ONLY when set, and should be set
 * only behind a proxy that overwrites it. Caddy sets X-Real-IP from
 * {remote_host}, and only Caddy publishes ports, so clients cannot spoof it.
 * Without the header, every request would appear to come from Caddy and share
 * one bucket.
 *
 * Otherwise the socket's remote address is used. Returns null when neither is
 * available (e.g. app.request in tests), so the IP rule is skipped rather than
 * lumping every client into one shared key.
 */
export function createClientIpResolver(
  options: { trustedHeader?: string | undefined } = {}
): ClientIpResolver {
  const header = options.trustedHeader?.trim().toLowerCase() || undefined;
  return (c) => {
    if (header) {
      const value = c.req.header(header)?.trim();
      return value ? value : null;
    }
    try {
      return getConnInfo(c).remote.address ?? null;
    } catch {
      // Not running under @hono/node-server (no incoming socket).
      return null;
    }
  };
}
