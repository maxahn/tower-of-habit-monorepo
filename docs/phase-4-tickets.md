# Phase 4 — Tickets

Detailed specs for every M4 ticket. The plan and build order live in `phase-4-PLAN.md`.

---

## 4.1 — Expo + expo-router + NativeWind wiring

**Goal:** a navigable skeleton with styled views and the shared package importing cleanly.

**Work:**

1. Install expo-router and its peer dependencies. Create the `app/` directory with the file-based routing structure:
   ```
   app/
     _layout.tsx          ← root layout: providers, auth gate, splash screen
     (auth)/
       _layout.tsx        ← no-chrome layout (no tabs)
       login.tsx          ← placeholder
       verify.tsx         ← placeholder
       profile-setup.tsx  ← placeholder
     (app)/
       _layout.tsx        ← tab layout
       (tabs)/
         _layout.tsx
         index.tsx        ← Habits tab placeholder
         towers.tsx       ← Towers tab placeholder
         settings.tsx     ← Settings tab placeholder
   ```
2. Install NativeWind v4 and configure the Metro/Babel/Tailwind integration per the Expo 57 + NativeWind docs. Add `tailwind.config.ts` scoped to `apps/mobile`.
3. Convert `app.json` to `app.config.ts`. Add `extra.apiUrl` reading from `process.env.API_URL` (default `http://localhost:3000`). Keep all existing config (`bundleIdentifier`, adaptive icon, etc.).
4. Add `env` blocks to each EAS profile in `eas.json`:
   - `dev`: `API_URL` = `http://localhost:3000` (overridden per developer)
   - `staging`: `API_URL` = staging VPS URL
   - `production`: `API_URL` = production VPS URL
5. Add `expo-splash-screen` — call `SplashScreen.preventAutoHideAsync()` in the root layout.
6. Verify `import { ... } from '@tower-of-habit/shared'` works in a placeholder screen (the existing `TEST_IMPORT` check in `App.tsx` can move to a placeholder tab).

**Acceptance criteria:**

- [ ] `pnpm -F mobile dev` launches and shows the tab bar with three placeholder tabs
- [ ] Navigating between tabs works
- [ ] A NativeWind `className` renders correctly (e.g., `className="bg-red-500"`)
- [ ] `@tower-of-habit/shared` imports resolve without errors
- [ ] `app.config.ts` exposes `extra.apiUrl`

---

## 4.2 — React Native Reusables components

**Goal:** a themed component library ready for auth screens.

**Work:**

1. Copy in RNR components needed for M4: Button, Input, Text, Card, Label, Separator, and any primitives they depend on.
2. Set up the NativeWind theme tokens (colors, spacing, typography) in `tailwind.config.ts`. Use a cohesive palette — the brand can be refined in M5 but the tokens should be stable.
3. Configure dark mode support via NativeWind's `darkMode: 'class'` strategy. The Settings tab will eventually offer a toggle; for now, follow the system preference.
4. Build a simple storybook-style screen (or just a `/dev` route behind `__DEV__`) showing each component in light and dark mode, to verify theming works.

**Acceptance criteria:**

- [ ] Button, Input, Text, Card render with consistent styling in both light and dark mode
- [ ] Components accept NativeWind `className` for overrides
- [ ] No external component library dependency in `package.json` — all source is local

---

## B1 — `isNewUser` flag (post-login-onboarding)

**Goal:** the mobile client can distinguish first-login from returning-login.

**Spec:** `.scratch/post-login-onboarding/spec.md`

**Work:**

1. In `AuthService.verifyCode`: track whether `createUser` was called. Return `isNewUser: true` when the user was just created.
2. Update `VerifiedSession` type to `{ token, user, isNewUser }`.
3. Update `verifyCodeResponseSchema` in `packages/shared` to include `isNewUser: z.boolean()`.
4. Update `createFakeAuthService` to track and return `isNewUser`.
5. Update existing auth tests that assert on the verify-code response shape.

**Acceptance criteria:**

- [ ] First verify for a new email → `isNewUser: true`
- [ ] Second verify for the same email → `isNewUser: false`
- [ ] All existing auth tests pass with the updated response shape

---

## 4.3 — TanStack Query + `apiFetch` wrapper

**Goal:** a typed data layer the auth screens can use.

**Work:**

1. Install `@tanstack/react-query`.
2. Create `lib/api-client.ts` with:
   - `createApiClient(config)` factory that takes `{ getToken, setToken, signOut, baseUrl }` and returns `{ apiFetch, refreshToken }`
   - `apiFetch<T>(path, options)` — builds the full URL from `baseUrl`, attaches `Authorization: Bearer <token>`, sends JSON, parses response
   - On non-2xx: throws `ApiError` with `status`, `code`, `message` fields parsed from the API's error envelope
   - On network failure: throws `NetworkError`
   - On 401: attempts one `POST /auth/refresh` call. On success: stores new token via `setToken`, retries original request. On failure: calls `signOut()`, throws.
   - In `__DEV__`: optionally validates response body against a provided zod schema (passed as a generic parameter or option)
3. Create `lib/query-client.ts` — `QueryClient` with sensible defaults: `staleTime: 5 * 60 * 1000`, `retry: 2` for queries, `retry: 0` for mutations.
4. Wire `QueryClientProvider` in the root layout, inside the auth provider.
5. Integrate with TanStack Query's `onlineManager` — use `@react-native-community/netinfo` to report connectivity status.

**Acceptance criteria:**

- [ ] `apiFetch` attaches the bearer token and parses JSON responses
- [ ] `apiFetch` throws `ApiError` on 4xx/5xx with `code` and `message` from the server
- [ ] `apiFetch` throws `NetworkError` on fetch failure
- [ ] 401 triggers one refresh attempt before throwing
- [ ] `QueryClient` is accessible throughout the app via provider
- [ ] `onlineManager` pauses queries when the device is offline

**Note:** the refresh-then-retry logic in `apiFetch` will be fully testable after B2 lands the backend endpoint. Until then, the 401 path can be unit-tested against a mock.

---

## 4.4 — OTP login + verify + profile setup screens

**Goal:** a user can sign in and set up their profile.

**Work:**

1. **Login screen** (`(auth)/login.tsx`):
   - Email input: `keyboardType="email-address"`, `autoCapitalize="none"`, `autoCorrect={false}`
   - "Continue with email" button with 30-second cooldown timer after a successful press. Button shows countdown text while disabled.
   - Calls `POST /auth/request-code` via `apiFetch`
   - Error states: 429 → "Too many attempts. Try again later." / 422 → "This email can't receive codes."
   - On success (202): navigate to `(auth)/verify` with email as a route param

2. **Verify screen** (`(auth)/verify.tsx`):
   - 6-box OTP input: auto-focus first box, auto-advance on digit entry, paste support, `textContentType="oneTimeCode"` for iOS autofill
   - Auto-submit when 6th digit is entered. Fallback "Verify" button for accessibility.
   - On success: call `authContext.signIn(token, expiresAt, user)` which stores credentials and sets auth state. If `isNewUser` → auth state becomes `onboarding` → root layout renders profile setup. If not → auth state becomes `authenticated` → root layout renders app tabs.
   - On invalid code (401): shake animation, clear boxes, "Invalid code" inline error
   - On 5 failed attempts (429): "Too many attempts" message, navigate back to login
   - "Resend code" link: visible after 30-second cooldown, calls `POST /auth/request-code`
   - Back button: returns to login

3. **Profile setup screen** (`(auth)/profile-setup.tsx`):
   - Display name input: required, minimum 2 characters. Placeholder: "What should we call you?"
   - Timezone: pre-filled from `Intl.DateTimeFormat().resolvedOptions().timeZone`, displayed read-only with a "Change" button that opens a timezone picker
   - "Get started" button: calls `PATCH /v1/me` with `{ displayName, timezone }`. On success: calls `authContext.updateUser(updatedUser)` which transitions state from `onboarding` to `authenticated`.
   - No skip button — this screen is mandatory.

4. **Auth context provider** (`lib/auth-context.tsx`):

   ```typescript
   type AuthState =
     | { status: 'loading' }
     | { status: 'unauthenticated' }
     | { status: 'onboarding'; user: User }
     | { status: 'authenticated'; user: User };
   ```
   - On cold boot: reads `{ token, expiresAt }` from expo-secure-store. If present and not expired → fetches `GET /v1/me` to get current user → if `displayName` is null → `onboarding`, else → `authenticated`. If token missing or expired → `unauthenticated`. Hides splash screen once state is determined.
   - `signIn`: stores token + expiresAt in secure-store, sets state based on `isNewUser`
   - `signOut`: clears secure-store, sets `unauthenticated`, calls `POST /auth/logout`
   - `updateUser`: replaces the user in state, transitions `onboarding` → `authenticated` if `displayName` is now non-null
   - Creates the `apiFetch` client with `getToken`/`setToken`/`signOut` closures

5. **Root layout auth gate** (`app/_layout.tsx`):
   - Reads `authContext.state.status` and renders the corresponding group
   - `loading` → native splash stays visible (no React content)
   - `unauthenticated` → redirects to `(auth)/login`
   - `onboarding` → redirects to `(auth)/profile-setup`
   - `authenticated` → renders `(app)` tabs

6. **Global error boundary**: wrap the root layout's children in an error boundary that catches unhandled throws and shows a "Something went wrong" screen with a "Restart" button.

**Acceptance criteria:**

- [ ] A new user can: enter email → receive code → enter code → see profile setup → enter display name → land on app tabs
- [ ] A returning user can: enter email → receive code → enter code → land on app tabs (no profile setup)
- [ ] The send-code button is disabled for 30 seconds after a successful press
- [ ] The verify screen auto-submits on 6th digit and supports paste
- [ ] iOS code autofill works via `textContentType="oneTimeCode"`
- [ ] Invalid codes show inline errors; 5 failures redirect to login
- [ ] Profile setup blocks access to app tabs until display name is submitted
- [ ] The global error boundary catches and displays unhandled errors

---

## B2 — Session token rotation

**Goal:** sessions rotate on refresh, with reuse detection.

**Spec:** `.scratch/session-token-rotation/spec.md`

**Work:**

1. Add `previousTokenHash` column (nullable) to `sessions` table. Migration.
2. Reduce `sessionTtlSeconds` from 90 days to 30 days.
3. Add `POST /v1/auth/refresh` endpoint (authenticated): generate new 32-byte token, atomically replace `tokenHash`, move old hash to `previousTokenHash`, extend `expiresAt` by 30 days. Return `{ token, expiresAt }`.
4. Update `authenticate` to check `previousTokenHash` with a 30-second grace window. After grace: reuse triggers full session revocation. Within grace: allow (in-flight requests).
5. Add `expiresAt` to `verifyCodeResponseSchema` in `packages/shared`.
6. Clean up dead `.env.dev` JWT vars if present.

**Acceptance criteria:**

- [ ] Refresh returns a new token; old token stops working after 30s grace
- [ ] Reuse of a rotated-out token (after grace) revokes the entire session
- [ ] Refresh of an expired session returns 401
- [ ] `expiresAt` is returned in both verify-code and refresh responses
- [ ] Full integration flow: login → use token → refresh → use new token → old token is 401

---

## 4.5 — Session restore + refresh-retry + sign-out

**Goal:** the app stays signed in across restarts and handles token expiry gracefully.

**Work:**

1. **Cold boot restore**: auth provider reads `{ token, expiresAt }` from secure-store on mount. If `expiresAt` is past → clear and go to `unauthenticated`. If within 7 days of expiry → proactively refresh before proceeding.
2. **Foreground refresh**: use `AppState` listener — when app comes to foreground, if token is within 7 days of expiry, trigger a background refresh.
3. **401 refresh-retry in `apiFetch`**: already scaffolded in 4.3, now fully testable with the real `POST /auth/refresh` endpoint from B2. Verify the full cycle: request → 401 → refresh → retry → success.
4. **Sign-out**: Settings tab gets a "Sign out" button. Calls `POST /auth/logout` (best-effort — don't block on it), clears secure-store, resets auth state, clears TanStack Query cache.
5. **Session revocation handling**: if a refresh attempt returns 401 (session revoked due to token reuse), sign out cleanly — no crash, no stuck state.

**Acceptance criteria:**

- [ ] App cold boot with a valid token → goes straight to app tabs (no login screen)
- [ ] App cold boot with an expired token → goes to login
- [ ] A 401 during normal use triggers a transparent refresh and retry
- [ ] A revoked session (reuse detection) results in a clean redirect to login
- [ ] Proactive refresh fires when the app foregrounds within 7 days of expiry
- [ ] Sign-out clears the token, resets state, and clears the query cache
- [ ] No spinner or flash of wrong screen during restore

---

## 4.6 — Push token registration

**Goal:** the app can receive push notifications.

**Work:**

1. Install `expo-notifications` and `expo-device`.
2. Create `lib/push.ts`:
   - `registerForPushNotifications()`: checks `Device.isDevice` (skip on simulator), requests permission via `Notifications.requestPermissionsAsync()`, gets Expo push token via `Notifications.getExpoPushTokenAsync()`, POSTs to `/v1/push-tokens` with `{ token, platform }`.
   - `checkPushPermissionStatus()`: returns current permission state without prompting.
3. **Soft-prompt screen**: when the user creates or joins their first tower, show an in-app bottom sheet or interstitial: "Tower of Habit sends nudges before deadlines so you never miss one. Enable notifications?" with "Turn on" (triggers OS prompt → register) and "Not now" (dismiss, persist the decline in `AsyncStorage` so we don't re-prompt every tower action).
4. **Settings tab**: show push notification status (enabled / disabled / not asked). If disabled, offer a "Turn on" button that deep-links to the app's OS notification settings.
5. **Token refresh on app foreground**: Expo push tokens can change. On each foreground event, re-fetch the token and POST it if it differs from the last-sent value (deduplicated by the server's unique constraint).

**Acceptance criteria:**

- [ ] Push permission prompt appears on first tower create/join (not before)
- [ ] A declined prompt doesn't re-appear on the next tower action (remembered)
- [ ] The push token is registered with the server on permission grant
- [ ] Settings tab shows the current push permission state
- [ ] A test push (sent via the API or Expo dashboard) is received on the device
- [ ] Simulator gracefully skips push registration without errors

---

## 4.7 — ESLint import barrier

**Goal:** CI fails if server-only code is imported into the mobile app.

**Work:**

1. Add ESLint `no-restricted-imports` rule to `apps/mobile` eslint config:
   - Block `@tower-of-habit/db` (and any sub-paths)
   - Block relative imports reaching into `apps/api` or `apps/worker`
   - Block `node:*` builtin imports (`node:crypto`, `node:fs`, `node:path`, etc.)
   - Block bare `crypto`, `fs`, `path`, `os`, `net`, `http`, `https` imports
2. Allow `@tower-of-habit/shared` (all entry points).
3. Verify the rule catches a deliberate violation and that `pnpm lint` fails.

**Acceptance criteria:**

- [ ] `import { anything } from '@tower-of-habit/db'` in `apps/mobile` → lint error
- [ ] `import { anything } from 'node:crypto'` in `apps/mobile` → lint error
- [ ] `import { anything } from '@tower-of-habit/shared'` → no error
- [ ] `pnpm lint` runs the rule as part of CI

---

## B3 — Auth codes cleanup job

**Goal:** expired auth codes don't accumulate forever.

**Spec:** `.scratch/auth-codes-cleanup/spec.md`

**Work:**

1. Add `deleteExpiredAuthCodes(db, retentionSeconds)` in `packages/db/src/auth/auth-codes.ts`. Deletes rows where `expiresAt + retentionSeconds < now()`.
2. Add `cleanup_auth_codes` task to the worker's Graphile Worker `taskList`. Calls `deleteExpiredAuthCodes` with retention = 86400 (24 hours).
3. Schedule via Graphile Worker cron: run once daily.
4. Log the count of deleted rows.

**Acceptance criteria:**

- [ ] Expired codes older than 24 hours are deleted
- [ ] Consumed codes older than 24 hours are deleted
- [ ] Recent codes (< 24 hours) are preserved regardless of state
- [ ] The job runs on the daily cron schedule
- [ ] Deleted row count is logged

---

## 4.9 — EAS build profiles (finish)

**Goal:** dev, staging, and production builds work end-to-end.

**Work:**

1. Verify the `dev` profile builds and installs on a physical device (iOS and/or Android). The profile already exists in `eas.json` with `developmentClient: true`.
2. Verify the `staging` profile builds with the staging `API_URL` baked in.
3. Add `expo-updates` configuration to `app.config.ts` for the staging and production channels (already partially configured — `channel` is set in `eas.json`).
4. Document the build commands in the project README or a `docs/mobile-dev.md`.

**Acceptance criteria:**

- [ ] `pnpm -F mobile build:dev` produces an installable dev-client build
- [ ] The dev build connects to the local API
- [ ] The staging build connects to the staging API
- [ ] Build commands are documented
