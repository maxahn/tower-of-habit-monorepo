# Phase 4 — Client Foundation

**Goal:** an Expo app that authenticates, navigates, and talks to the API — no tower UI yet.

**Estimate:** 10–14 days.

---

## Status

| Ticket  | Scope                                      | State          |
| ------- | ------------------------------------------ | -------------- |
| **4.1** | Expo + router + NativeWind wiring          | ⬜ not started |
| **4.2** | React Native Reusables components          | ⬜ not started |
| **B1**  | `isNewUser` flag (post-login-onboarding)   | ⬜ not started |
| **4.3** | TanStack Query + `apiFetch` wrapper        | ⬜ not started |
| **4.4** | OTP login + verify + profile setup         | ⬜ not started |
| **B2**  | Session token rotation                     | ⬜ not started |
| **4.5** | Session restore + refresh-retry + sign-out | ⬜ not started |
| **4.6** | Push token registration                    | ⬜ not started |
| **4.7** | ESLint import barrier                      | ⬜ not started |
| **B3**  | Auth codes cleanup job                     | ⬜ not started |
| **4.9** | EAS build profiles (finish)                | ⬜ not started |

4.8 (change-of-email) deferred to M6.

---

## Build order

Tickets are sequenced so each backend change lands right before the client work that needs it.

```
4.1  Expo + router + NativeWind
 ↓
4.2  RNR components
 ↓
B1   isNewUser backend flag
 ↓
4.3  TanStack Query + apiFetch
 ↓
4.4  OTP login + verify + profile setup
 ↓
B2   Session token rotation backend
 ↓
4.5  Session restore + refresh-retry + sign-out
 ↓
4.6  Push token registration
 ↓
4.7  ESLint import barrier
 ↓
B3   Auth codes cleanup (no client dependency — can land anywhere)
 ↓
4.9  EAS build profiles
```

---

## Key decisions

| #   | Decision           | Resolution                                                                                                                                                                                              |
| --- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Navigation library | expo-router (file-based, wraps React Navigation)                                                                                                                                                        |
| D2  | Styling            | NativeWind v4 (Tailwind on React Native)                                                                                                                                                                |
| D3  | Component library  | React Native Reusables — copy-in, not a dependency                                                                                                                                                      |
| D4  | Server state       | TanStack Query with manual query hooks                                                                                                                                                                  |
| D5  | Token storage      | expo-secure-store (Keychain / EncryptedSharedPreferences)                                                                                                                                               |
| D6  | API URL strategy   | `app.config.ts` with per-profile `API_URL` via EAS `env` blocks                                                                                                                                         |
| D7  | Route structure    | `(auth)` group (no tabs) / `(app)` group (3 tabs: Habits, Towers, Settings)                                                                                                                             |
| D8  | Profile setup      | Mandatory — blocks app access until `displayName` is set. Enforced client-side via root layout redirect. Called "profile setup" (not "onboarding" — that term is reserved for M5 first-run experience). |
| D9  | Fetch wrapper      | Thin `apiFetch` that throws a typed `ApiError`. Response validation via shared zod schemas in `__DEV__` only.                                                                                           |
| D10 | 401 handling       | Refresh-then-retry. `apiFetch` intercepts 401, calls `POST /auth/refresh`, retries. If refresh fails → sign out.                                                                                        |
| D11 | Proactive refresh  | Server returns `expiresAt` in verify-code and refresh responses. Client refreshes on foreground when within 7 days of expiry.                                                                           |
| D12 | Auth context       | 4-state machine: `loading` → splash, `unauthenticated` → login, `onboarding` → profile setup, `authenticated` → app tabs. Auth functions injected into `apiFetch` via closure.                          |
| D13 | Push prompt        | Soft-prompt at first tower create/join — not during profile setup.                                                                                                                                      |
| D14 | Offline (M4 scope) | Minimal: `NetworkError` type + TanStack Query `onlineManager`. Full offline/retry is M5.                                                                                                                |
| D15 | Dev workflow       | Dev client build on physical device + iOS Simulator throughout. No Expo Go.                                                                                                                             |
| D16 | Backend tickets    | Three `.scratch/` tickets interleaved: `post-login-onboarding`, `session-token-rotation`, `auth-codes-cleanup`.                                                                                         |

---

## Acceptance criteria

- [ ] `packages/shared` types import into the client with no database driver or Node builtin pulled in
- [ ] Login survives an app restart and a cold boot
- [ ] A 401 mid-session triggers a token refresh; if refresh succeeds the original request retries transparently
- [ ] A reused (rotated-out) token revokes the entire session
- [ ] Profile setup is mandatory — the app tabs are inaccessible until `displayName` is set
- [ ] Push permission denial is handled: the app works, notifications are off, and the state is visible in settings
- [ ] The ESLint import barrier fails lint when `@tower-of-habit/db`, `apps/api`, `apps/worker`, or `node:*` builtins are imported in `apps/mobile`
- [ ] An internal dev-client build installs on a physical device
- [ ] The send-code button enforces a 30-second cooldown after a successful press

## Exit gate

A real device logs in with an emailed code, completes profile setup, registers a push token, receives a test push, and survives a cold restart still signed in. A mid-session 401 triggers a silent refresh and retry.
