Status: ready-for-agent

# Session Token Rotation

## Problem Statement

A session bearer token is valid for 90 days with no rotation. If a token is exfiltrated (stolen device, clipboard sniffing, log leak), the attacker has the full 90-day window. There is no mechanism to detect token theft or limit its impact.

## Solution

Reduce session lifetime to 30 days and introduce token rotation via a new `POST /v1/auth/refresh` endpoint. Each refresh issues a new bearer token (invalidating the old one) and extends the session by 30 days. If a rotated-out token is reused, the entire session is revoked (theft signal).

## User Stories

1. As a mobile user, I want my session to stay alive as long as I use the app regularly, so that I don't have to re-authenticate every 30 days.
2. As a user whose device was stolen, I want the stolen token to stop working after the next legitimate refresh, so that my account is protected.
3. As a security-conscious user, I want the system to detect when a rotated-out token is reused and revoke the entire session, so that token theft is caught.
4. As a mobile developer, I want a clear refresh contract (call refresh when a 401 is received or proactively before expiry), so that I can implement seamless token management.
5. As an operator, I want to see when tokens were last rotated, so that I can identify stale sessions.

## Implementation Decisions

- Keep the single opaque token model (no JWT access/refresh split). The current stateful-session-in-Postgres architecture is appropriate for this app's scale and threat model. JWTs add complexity (key management, revocation lag) without meaningful benefit here.
- Add `POST /v1/auth/refresh` (authenticated): generates a new 32-byte token, atomically replaces `tokenHash` on the session row, extends `expiresAt` by 30 days from now. Returns `{ token }`. The old token is immediately invalid.
- Add `previousTokenHash` column to `sessions` table (nullable, varchar(64)). On refresh, the old hash moves here. If `authenticate` sees a request matching `previousTokenHash`, it revokes the session (reuse detection) and returns null.
- Reduce `sessionTtlSeconds` from 90 days to 30 days in the composition root.
- The `previousTokenHash` has a short grace window (e.g., 30 seconds) to handle in-flight requests that used the old token during rotation. After the grace window, reuse triggers revocation.
- Client contract: on 401, attempt one refresh. If refresh also returns 401, redirect to login. Proactive refresh: when the token is within 7 days of expiry, refresh on next app foreground.
- Clean up dead `.env.dev` JWT vars (`JWT_SECRET`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`) — they are unused config from a discarded approach.

## Testing Decisions

- Test at the `AuthService` interface seam (unit tests with the fake service, plus the real service in integration tests).
- Unit tests: refresh returns new token, old token stops working, reuse of old token revokes session, refresh of expired session fails, refresh extends expiry.
- Integration tests: full flow — OTP login → use token → refresh → use new token → old token is 401 → reuse old token → session revoked.
- Prior art: existing `routes.test.ts` and `routes.integration.test.ts` patterns.

## Out of Scope

- JWT-based access tokens. The opaque token model is kept.
- Refresh token as a separate entity from the session token. One token, rotated in place.
- Automatic server-side rotation (the client must call refresh explicitly).

## Further Notes

Industry reference: this is a simplified version of OAuth2 refresh token rotation (RFC 6749 §6, Auth0's rotation spec). The key insight is reuse detection — if both the legitimate client and an attacker have the same refresh token, the first to use it rotates it, and the second triggers revocation. The 30-second grace window handles network-level races without weakening the theft signal.
