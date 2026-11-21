import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app.js';
import { DomainError } from '../errors.js';
import type { AuthService } from './service.js';

const BEARER_PREFIX = 'Bearer ';

/**
 * Session auth (2.9). Replaces the 2.8 denyAll placeholder as deps.auth. Reads a
 * bearer token, resolves it through authenticate, and on success attaches
 * userId and sessionId to the context for downstream handlers.
 *
 * Any failure — no header, unknown, expired, or revoked session — is a single
 * 401 `unauthenticated`. Deliberately 401, never 403: the credential is missing
 * or no longer valid, not a permission the caller lacks.
 *
 * last_seen_at refresh (at most hourly) is the service's job inside
 * authenticate, not the middleware's.
 */
export function createSessionMiddleware(
  authService: Pick<AuthService, 'authenticate'>
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization');
    const token = header?.startsWith(BEARER_PREFIX)
      ? header.slice(BEARER_PREFIX.length)
      : undefined;
    const identity = token ? await authService.authenticate(token) : null;
    if (!identity) {
      throw new DomainError(401, 'unauthenticated', 'Missing or invalid session');
    }
    c.set('userId', identity.userId);
    c.set('sessionId', identity.sessionId);
    await next();
  };
}
