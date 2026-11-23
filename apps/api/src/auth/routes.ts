import { requestCodeRequestSchema, verifyCodeRequestSchema } from '@tower-of-habit/shared';
import type { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import { DomainError } from '../errors.js';
import type { ClientIpResolver } from '../rate-limit/client-ip.js';
import { enforceRateLimits, type RateLimitDeps } from '../rate-limit/enforce.js';
import type { RateRule } from '../rate-limit/limiter.js';
import { jsonBody } from '../validation.js';
import { hashEmail } from './crypto.js';
import type { AuthService } from './service.js';

/**
 * The four auth endpoints (2.9), rate limited per 2.18.
 *
 * Fixed 15-minute windows in Redis: request-code 3 per email and 10 per client
 * IP, verify-code 10 per email. Over the limit → 429 too_many_requests with
 * Retry-After. Emails are hashed before they become Redis keys. If Redis is
 * unreachable, request-code fails open and verify-code fails CLOSED (2.18):
 * the limiter is load-bearing for verify, where a 6-digit code is 10^6
 * candidates. The per-code 5-attempt cap is a separate control: it lives on
 * the auth_codes row and the service enforces it.
 */

const WINDOW_SECONDS = 15 * 60;

export const REQUEST_CODE_PER_EMAIL: RateRule = {
  name: 'request-code:email',
  limit: 3,
  windowSeconds: WINDOW_SECONDS,
};
export const REQUEST_CODE_PER_IP: RateRule = {
  name: 'request-code:ip',
  limit: 10,
  windowSeconds: WINDOW_SECONDS,
};
export const VERIFY_CODE_PER_EMAIL: RateRule = {
  name: 'verify-code:email',
  limit: 10,
  windowSeconds: WINDOW_SECONDS,
};

export type PublicAuthRouteDeps = {
  authService: AuthService;
  rateLimit: RateLimitDeps & { clientIp: ClientIpResolver };
};

/**
 * Public routes (no session). Mounted on the pre-auth /v1 router.
 *   POST /auth/request-code  → always 202, empty body (no account enumeration)
 *   POST /auth/verify-code   → { token, user }, or 401 invalid_code
 * Both → 429 too_many_requests when rate limited; verify-code → 503
 * rate_limiter_unavailable when the limiter is down.
 */
export function mountPublicAuthRoutes(api: Hono<AppEnv>, deps: PublicAuthRouteDeps): void {
  const { rateLimit } = deps;

  api.post('/auth/request-code', jsonBody(requestCodeRequestSchema), async (c) => {
    const { email } = c.req.valid('json');
    await enforceRateLimits(rateLimit, [
      { rule: REQUEST_CODE_PER_IP, id: rateLimit.clientIp(c) },
      { rule: REQUEST_CODE_PER_EMAIL, id: hashEmail(email) },
    ]);
    await deps.authService.requestCode(email);
    // 202 for known and unknown emails alike: the response must not reveal
    // whether an account exists.
    return c.body(null, 202);
  });

  api.post('/auth/verify-code', jsonBody(verifyCodeRequestSchema), async (c) => {
    const { email, code, timezone } = c.req.valid('json');
    await enforceRateLimits(rateLimit, [{ rule: VERIFY_CODE_PER_EMAIL, id: hashEmail(email) }], {
      failClosed: true,
    });
    const result = await deps.authService.verifyCode({
      email,
      code,
      timezone,
      userAgent: c.req.header('user-agent') ?? null,
    });
    // One body, one status for every failure: wrong, consumed, expired, unknown.
    if (!result) {
      throw new DomainError(401, 'invalid_code', 'The code is incorrect or has expired');
    }
    return c.json(result, 200);
  });
}

/**
 * Authenticated routes. Mounted on the /v1 router that runs behind the session
 * middleware, so userId and sessionId are always set.
 *   POST /auth/refresh              → { token, expiresAt }, rotates the session token
 *   POST /auth/logout               → 204, revokes the current session
 *   POST /auth/sessions/revoke-all  → 204, revokes every session for the user
 */
export function mountAuthedAuthRoutes(api: Hono<AppEnv>, deps: { authService: AuthService }): void {
  api.post('/auth/refresh', async (c) => {
    const header = c.req.header('authorization');
    const rawToken = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!rawToken) {
      throw new DomainError(401, 'unauthenticated', 'Missing or invalid session');
    }
    const result = await deps.authService.refreshSession(rawToken);
    if (!result) {
      throw new DomainError(401, 'unauthenticated', 'Session expired or revoked');
    }
    return c.json(result, 200);
  });

  api.post('/auth/logout', async (c) => {
    await deps.authService.revokeSession(c.get('sessionId'));
    return c.body(null, 204);
  });

  api.post('/auth/sessions/revoke-all', async (c) => {
    await deps.authService.revokeAllSessions(c.get('userId'));
    return c.body(null, 204);
  });
}
