import { requestCodeRequestSchema, verifyCodeRequestSchema } from '@tower-of-habit/shared';
import type { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import { DomainError } from '../errors.js';
import { jsonBody } from '../validation.js';
import type { AuthService } from './service.js';

/**
 * The four auth endpoints (2.9).
 *
 * TODO(2.18): per-email (3/15m) and per-IP (10/15m) limits on request-code, and
 * per-email (10/15m) on verify-code, returning 429 with Retry-After. The Redis
 * rate-limit primitive does not exist yet; the error envelope for 429
 * too_many_requests already does. The per-code 5-attempt cap is NOT this — it
 * lives on the auth_codes row and is enforced by the service.
 */

/**
 * Public routes (no session). Mounted on the pre-auth /v1 router.
 *   POST /auth/request-code  → always 202, empty body (no account enumeration)
 *   POST /auth/verify-code   → { token, user }, or 401 invalid_code
 */
export function mountPublicAuthRoutes(api: Hono<AppEnv>, deps: { authService: AuthService }): void {
  api.post('/auth/request-code', jsonBody(requestCodeRequestSchema), async (c) => {
    const { email } = c.req.valid('json');
    await deps.authService.requestCode(email);
    // 202 for known and unknown emails alike: the response must not reveal
    // whether an account exists.
    return c.body(null, 202);
  });

  api.post('/auth/verify-code', jsonBody(verifyCodeRequestSchema), async (c) => {
    const { email, code, timezone } = c.req.valid('json');
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
 *   POST /auth/logout               → 204, revokes the current session
 *   POST /auth/sessions/revoke-all  → 204, revokes every session for the user
 */
export function mountAuthedAuthRoutes(api: Hono<AppEnv>, deps: { authService: AuthService }): void {
  api.post('/auth/logout', async (c) => {
    await deps.authService.revokeSession(c.get('sessionId'));
    return c.body(null, 204);
  });

  api.post('/auth/sessions/revoke-all', async (c) => {
    await deps.authService.revokeAllSessions(c.get('userId'));
    return c.body(null, 204);
  });
}
