Status: ready-for-agent

# Post-Login Onboarding (`isNewUser` flag)

## Problem Statement

When a new user signs up (first successful code verification auto-creates their account), the mobile client has no signal from the server that this is a first-time user who needs onboarding (setting display name, confirming timezone, etc.). The client would have to infer it from missing fields, which is fragile.

## Solution

Add an `isNewUser` boolean to the `verify-code` response so the mobile client can branch to an onboarding flow on first login. The onboarding itself uses the existing `PATCH /me` endpoint.

## User Stories

1. As a new user, I want to be guided through setting my display name and confirming my timezone after my first login, so that my profile is complete before I start using the app.
2. As a returning user, I want to skip the onboarding screen on login, so that I go straight to my habits.
3. As a mobile developer, I want an explicit `isNewUser` flag in the verify-code response, so that I can reliably determine whether to show the onboarding flow.
4. As a new user, I want my timezone to be pre-filled from the code I submitted during verification, so that I don't have to set it again.

## Implementation Decisions

- In `AuthService.verifyCode`: track whether `createUser` was called (vs. `findUserByEmail` returning an existing user). Return `isNewUser: true` when the user was just created.
- Update `VerifiedSession` type to `{ token, user, isNewUser }`.
- Update `verifyCodeResponseSchema` in `packages/shared` to include `isNewUser: z.boolean()`.
- The in-memory fake service (`createFakeAuthService`) must also track and return `isNewUser`.
- The `PATCH /me` endpoint already handles `displayName` and `timezone` — no backend changes needed for the onboarding fields themselves.
- The `timezone` sent in `verify-code` is already used to set the user's timezone on creation, so the onboarding screen can show it pre-filled from `GET /me`.

## Testing Decisions

- Unit test: verify-code for a new email returns `isNewUser: true`; verify-code for an existing user returns `isNewUser: false`.
- Integration test: first verify → `isNewUser: true`, second verify (new code, same email) → `isNewUser: false`.
- Modify existing auth tests that assert on the verify-code response shape to include `isNewUser`.
- Prior art: existing `routes.test.ts` and `auth.integration.test.ts` patterns.

## Out of Scope

- Mobile client onboarding UI (this ticket covers the backend signal only).
- Additional onboarding fields beyond displayName and timezone (e.g., avatar, notification preferences). Those can be added to `PATCH /me` later.
- Mandatory onboarding enforcement (e.g., blocking API access until displayName is set). The user can skip onboarding and set it later.

## Further Notes

The `isNewUser` flag is a one-time signal at login time. It is not persisted or queryable — it's derived from whether the verify-code flow created a new user row. If the client misses it (app crash during onboarding), it can fall back to checking `displayName === null` from `GET /me`.
