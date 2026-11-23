# Phase 5 — Tickets

Detailed specs for every M5 ticket. The plan and build order live in `phase-5-PLAN.md`.

---

## 5.1 — Habit creation + tier ladder editor

**Goal:** a user can create binary, numeric, and tiered habits from the Habits tab.

**Files:**

- `apps/mobile/app/(tabs)/habits/create.tsx` — creation form
- `apps/mobile/lib/hooks/use-habits.ts` — TanStack Query hooks (`useCreateHabit`, `useHabits`)
- `apps/mobile/components/tier-ladder-editor.tsx` — reusable tier editor component

**Work:**

1. Create the habit creation screen with react-hook-form + zodResolver using `createHabitRequestSchema` from shared.
2. Three habit types selectable at the top: binary ("Did you do it?"), numeric ("How much?"), tiered ("Which level?").
3. Common fields: name (required), period unit (day/week), period length (default 1), quota (default 1 for daily).
4. Numeric-specific: unit label (e.g. "minutes", "pages"), threshold value for tier 0.
5. Tiered-specific: inline tier ladder editor. Start with one tier (label + optional threshold). "Add tier" button appends a row. Each row has label, threshold (optional), and a delete button (minimum 1 tier). Tier indices are contiguous from 0, thresholds strictly increasing — validate before submit.
6. `useCreateHabit` mutation calls `POST /habits` and invalidates the habits list query on success.
7. On success, navigate back to the habits list.

**Acceptance:**

- [ ] All three habit types create successfully and appear in the list
- [ ] Validation errors show inline (empty name, non-increasing thresholds, etc.)
- [ ] The tier ladder enforces at least 1 tier and strictly increasing thresholds

---

## 5.2 — Habit list + standalone habit view

**Goal:** the Habits tab shows all habits with streaks; tapping one opens a detail screen with entry history.

**Files:**

- `apps/mobile/app/(tabs)/habits/index.tsx` — habit list (replaces placeholder)
- `apps/mobile/app/(tabs)/habits/[id].tsx` — habit detail
- `apps/mobile/app/(tabs)/habits/_layout.tsx` — stack navigator
- `apps/mobile/lib/hooks/use-habits.ts` — add `useHabit`, `useHabitEntries`

**Work:**

1. Convert the Habits tab to a stack navigator with index (list) and [id] (detail) routes.
2. Habit list: `GET /habits` → FlatList. Each row shows name, type badge, current streak, period info. Sorted by lifecycle (active first) then name.
3. Pull-to-refresh on the list.
4. Habit detail screen: header with name, type, period, quota. Current streak displayed prominently. Entry history as a reverse-chronological list from `GET /habits/:id/entries`. Tower association shown if the habit is in a tower (from `habitDetailResponseSchema.tower`).
5. Edit button in the header → navigates to an edit screen (reuses the create form with pre-filled values, `PATCH /habits/:id`).
6. Archive action (confirmation dialog → `POST /habits/:id/archive`). Archived habits appear greyed at the bottom of the list.

**Acceptance:**

- [ ] Habits list loads, shows streak per habit, supports pull-to-refresh
- [ ] Tapping a habit opens detail with entry history
- [ ] Edit and archive work end-to-end
- [ ] Archived habits appear greyed out at the bottom

---

## 5.3 — Logging: binary, numeric, tier picker

**Goal:** the core action — logging an entry for a habit.

**Files:**

- `apps/mobile/components/log-entry.tsx` — logging UI component (binary button, numeric input, tier picker)
- `apps/mobile/lib/hooks/use-entries.ts` — `useLogEntry` mutation
- Update `apps/mobile/app/(tabs)/habits/[id].tsx` to include logging

**Work:**

1. Logging UI lives on the habit detail screen, prominently above the entry history.
2. Binary habits: a single large "Done" button. Tapping logs tier 0, no numeric value.
3. Numeric habits: a number input + "Log" button. The input is pre-focused. Submitting sends `numericValue`. Show the threshold needed to qualify.
4. Tiered habits: a vertical list of tier labels. Tapping a tier logs that tier index + its threshold as numeric value. Highlight the selected tier with a check.
5. Optimistic mutation: generate a `clientEntryId` (uuid) before submitting. Add the entry to the query cache immediately. If the server returns an error, roll back and show a toast.
6. After logging, the entry appears in history and the streak updates (invalidate habit detail query).
7. If the habit is in a tower, also invalidate the tower detail query so the period preview reflects the new log.
8. Duplicate protection: disable the log button for 1 second after a successful log. The `clientEntryId` on the server prevents true duplicates.

**Acceptance:**

- [ ] Binary, numeric, and tiered logging all work
- [ ] Optimistic update: entry appears immediately, reverts on error
- [ ] Double-tap produces one credit and no error toast
- [ ] Streak updates after logging

---

## 5.4 — Tower creation + deadline picker

**Goal:** a user can create a tower, selecting their habit, deadline time, timezone, and grace window.

**Files:**

- `apps/mobile/app/(tabs)/towers/create.tsx` — creation form
- `apps/mobile/components/deadline-picker.tsx` — time picker defaulting to 22:00
- `apps/mobile/lib/hooks/use-towers.ts` — `useCreateTower`, `useTowers`

**Work:**

1. Tower creation form with react-hook-form + zodResolver using `createTowerRequestSchema`.
2. Fields: name, habit (picker from user's active non-tower habits), period unit, period length, quota, deadline time, timezone (defaults to device timezone), grace window minutes.
3. Deadline picker: defaults to 22:00. Time-only picker (hours and minutes). Show a warning if the selected time would be an odd local hour (e.g. 3 AM) for the user's timezone — this matters when members are in distant timezones.
4. Wobble and nudge lead minutes: use defaults from shared (`DEFAULT_WOBBLE_LEAD_MINUTES`, `DEFAULT_NUDGE_LEAD_MINUTES`). Advanced section expandable to override.
5. `useCreateTower` mutation calls `POST /towers` and navigates to the new tower's lobby on success.
6. Habit picker: only shows active habits not already in a tower. If no eligible habits exist, show a prompt to create one first.

**Acceptance:**

- [ ] Tower creates successfully with selected habit
- [ ] Deadline defaults to 22:00, timezone to device timezone
- [ ] Habit picker excludes habits already in a tower
- [ ] No eligible habits → "Create a habit first" prompt

---

## 5.5 — Lobby: code sharing, member list, start

**Goal:** the tower lobby screen where the host shares the join code and starts the tower.

**Files:**

- `apps/mobile/app/(tabs)/towers/[id]/index.tsx` — tower detail (lobby or active, via discriminated union)
- `apps/mobile/app/(tabs)/towers/[id]/_layout.tsx` — stack for tower sub-screens
- `apps/mobile/components/lobby.tsx` — lobby view component

**Work:**

1. Tower detail screen fetches `GET /towers/:id`. The response is a discriminated union: `kind: 'lobby'` or `kind: 'active'`. This ticket handles the lobby case.
2. Lobby view shows:
   - Tower name and settings summary (period, quota, deadline)
   - Join code formatted as `XXXX-XXXX` with a copy button and share button (native share sheet)
   - Member list: each row shows display name, habit name, habit type badge. The host has a "Host" badge.
   - Host sees a "Remove" action on each non-self member (swipe or long press → `DELETE /towers/:id/memberships/:membershipId`)
   - Host sees a "Start Tower" button (disabled until ≥ 2 members). Calls `POST /towers/:id/start`.
3. Non-host members see a "Leave" action instead of Remove/Start.
4. Pull-to-refresh to pick up new members who joined.
5. After start, the response triggers a refetch that switches the view to the active tower home (5.7).

**Acceptance:**

- [ ] Join code displayed, copyable, shareable
- [ ] Member list updates on pull-to-refresh
- [ ] Host can remove members and start the tower (≥ 2 members)
- [ ] Non-host can leave
- [ ] Starting transitions to the active tower view

---

## 5.6 — Join by code

**Goal:** a user can join an existing tower by entering its join code.

**Files:**

- `apps/mobile/app/(tabs)/towers/join.tsx` — join screen (modal)
- `apps/mobile/lib/hooks/use-towers.ts` — add `useJoinTower`

**Work:**

1. Join screen presented as a modal from the towers list (FAB or header button).
2. Input field for the 8-character join code. Auto-uppercase, strip non-alphanumeric. Accept with or without a hyphen separator.
3. Habit picker: select which of their active, non-tower habits to bring. Same picker as 5.4.
4. Submit calls `POST /towers/join` with `{ joinCode, habitId }`.
5. On success, navigate to the tower lobby/detail screen.
6. Error handling: invalid code (404), already a member (409), rate limited (429).

**Acceptance:**

- [ ] Can join a tower by code and see the lobby
- [ ] Habit picker only shows eligible habits
- [ ] Error states displayed clearly (invalid code, already joined, rate limited)

---

## 5.7 — Tower home: height, streak, members, period

**Goal:** the active tower screen — the central view of the product.

**Files:**

- `apps/mobile/components/tower-home.tsx` — active tower view component
- `apps/mobile/components/member-row.tsx` — member status row
- Update `apps/mobile/app/(tabs)/towers/[id]/index.tsx` to handle `kind: 'active'`

**Work:**

1. Active tower view (from `towerActiveResponseSchema`) shows:
   - **Header:** tower name, height (current run) and total height (sum of block heights + current), streak count. Height and streak are two distinct numbers, never summed.
   - **Current period:** period number, start/end dates, deadline (from `deadlineAt`). Period state badge (pending, wobbling, etc.).
   - **Member grid/list:** each member row shows display name, habit name, membership state (active/at_risk/dormant), and whether they've met quota for the current period. Use `towerMemberSchema` fields.
   - **Wobble indicator:** when the period state indicates wobbling, show a visual warning. Identify which members are outstanding (haven't met quota).
2. The tower's `soloActive` flag triggers the solo warning (5.12).
3. Navigation: back to tower list. Sub-navigation to strata history (5.10).
4. Pull-to-refresh reloads the tower detail.
5. If the user's own membership is active/at_risk, show a prominent "Log" shortcut that navigates to their habit's logging screen.

**Acceptance:**

- [ ] Height and streak shown as two distinct numbers
- [ ] Member states displayed correctly (active, at_risk, dormant)
- [ ] Period info uses `deadlineAt` only
- [ ] Pull-to-refresh works
- [ ] "Log" shortcut navigates to the user's habit

---

## 5.8 — Countdown timer anchored to deadline_at

**Goal:** a live countdown to the period deadline.

**Files:**

- `apps/mobile/components/countdown.tsx` — countdown component

**Work:**

1. A `Countdown` component that takes a `deadlineAt` ISO timestamp.
2. Displays days, hours, minutes, seconds remaining. Updates every second via `useEffect` + `setInterval`.
3. When time is up: shows "Evaluating..." or "Past deadline" rather than negative numbers.
4. Visual urgency tiers: normal (> 24h), attention (< 24h, amber), urgent (< 1h, red).
5. Placed on the tower home screen (5.7) below the period info.
6. Performance: the interval cleans up on unmount. No Reanimated here — a 1s `setInterval` is fine for text.

**Acceptance:**

- [ ] Countdown ticks accurately against `deadlineAt`
- [ ] Shows appropriate urgency styling
- [ ] Cleans up interval on unmount
- [ ] Never shows `evaluateAt`

---

## 5.9 — Tower animation (Reanimated)

**Goal:** a visual tower that grows with height and collapses visually.

**Files:**

- `apps/mobile/components/tower-visual.tsx` — animated tower component
- `apps/mobile/components/tower-visual-boundary.tsx` — swappable boundary wrapper

**Work:**

1. The tower visual is a component that takes `height`, `blocks` (base block history), and `isCollapsing` as props.
2. Renders stacked blocks using `react-native-reanimated`. Each unit of height is a block segment. Base blocks (previous runs) rendered in a muted color underneath the current run.
3. Entry animation: when height increases, the new block slides/fades in from the top.
4. Collapse animation: when `isCollapsing` is true (or height resets), blocks tumble/fade and the base block appears.
5. Wrap in a `TowerVisualBoundary` component that imports the Reanimated version. This boundary is the swap point for a future Skia renderer — the boundary component is the only file that needs to change.
6. Keep performance in mind: use `useAnimatedStyle`, avoid JS-thread animations. Target 60fps on a Pixel 6a equivalent.
7. The tower visual sits at the top of the tower home screen (5.7).

**Acceptance:**

- [ ] Tower grows visually as height increases
- [ ] Base blocks visible beneath current run
- [ ] Animation runs at 60fps on a mid-range device
- [ ] Boundary component is swappable without touching the tower home

---

## 5.10 — Base block history (strata view)

**Goal:** a geological strata view of the tower's history — each collapsed run is a layer.

**Files:**

- `apps/mobile/app/(tabs)/towers/[id]/history.tsx` — strata history screen
- `apps/mobile/components/strata-block.tsx` — single block row

**Work:**

1. Screen accessible from the tower home (button or tab).
2. FlatList of `baseBlockResponseSchema` items, newest on top.
3. Each row shows: ordinal ("Run #N"), block height, date range (`runStartDate` → `runEndDate`), member count from roster.
4. Tap a block to expand and show the full roster: each member's display name and habit name.
5. The current run (not yet a base block) appears at the top as a special "Current run" card with live height.
6. Empty state: "No previous runs yet — this is your tower's first attempt."

**Acceptance:**

- [ ] Base blocks listed newest-first with height and date range
- [ ] Tap expands to show roster
- [ ] Current run shown at top
- [ ] Empty state when no blocks exist

---

## 5.11 — Dormancy and absence UI

**Goal:** members can see dormancy states and declare/cancel absences.

**Files:**

- `apps/mobile/components/absence-controls.tsx` — declare/cancel absence UI
- `apps/mobile/lib/hooks/use-absence.ts` — `useDeclareAbsence`, `useCancelAbsence`
- Update member rows and tower home

**Work:**

1. Member row enhancements:
   - `at_risk`: yellow/amber badge, "At risk" label.
   - `dormant`: greyed out row. Show `dormancyReason` (consecutive miss, backstop, voluntary) and `dormantSince`.
   - If a member has a `voluntaryReturnDate`, show "Returns [date]" on their row.
2. Absence controls on the tower detail for the current user:
   - "Declare absence" button → date picker for return date. Validates: max 14 days, only one active absence at a time, annual budget of 28 days. Calls `POST /towers/:id/absence`.
   - If absence is active: "Cancel absence" button → `DELETE /towers/:id/absence`. Confirmation dialog.
3. Show the user's own membership state prominently if at_risk or dormant.

**Acceptance:**

- [ ] Dormant members greyed out with reason
- [ ] At-risk members have amber indicator
- [ ] Absence can be declared with return date and cancelled
- [ ] Validation enforced (14-day cap, annual budget)

---

## 5.12 — Solo-active warning

**Goal:** when you're the only active member, the UI tells you clearly.

**Files:**

- `apps/mobile/components/solo-warning.tsx` — warning banner
- Update tower home

**Work:**

1. When `soloActive: true` in the tower detail response, show a prominent but non-alarming banner: "You're the only active member. The tower continues as long as you do."
2. The banner sits below the countdown, above the member list.
3. Style: informational (blue/neutral), not alarming (not red). This is a state, not an emergency.

**Acceptance:**

- [ ] Banner appears when `soloActive` is true
- [ ] Banner disappears when another member becomes active
- [ ] Tone is informational, not alarming

---

## 5.13 — Empty states and first-run guidance

**Goal:** guide new users from "I just signed up" to "I'm in a tower."

**Files:**

- `apps/mobile/components/empty-state.tsx` — reusable empty state component
- Update habits list, towers list, habit detail (no entries)

**Work:**

1. Habits tab empty state: "Create your first habit to get started." CTA button → habit creation.
2. Towers tab empty state: "Create a tower to build streaks with friends, or join one with a code." Two CTA buttons → create tower, join tower.
3. Habit detail with no entries: "Log your first entry to start your streak." Visual nudge toward the logging controls.
4. Tower detail with no blocks: "This is your tower's first attempt. Keep going!" (Already handled in 5.10, but confirm here.)
5. Keep empty states minimal — one illustration slot (placeholder icon), one sentence, one CTA. No walls of text.

**Acceptance:**

- [ ] Each list screen has a meaningful empty state
- [ ] CTAs navigate to the right creation/action screen
- [ ] Empty states are concise (one sentence + one action)

---

## 5.14 — Offline and flaky-connection handling

**Goal:** the app doesn't break when the network is spotty.

**Files:**

- `apps/mobile/components/offline-banner.tsx` — offline indicator
- `apps/mobile/lib/hooks/use-entries.ts` — update logging mutation for offline retry
- Update `apps/mobile/lib/online-manager.ts` if needed

**Work:**

1. Offline banner: when `onlineManager.isOnline()` is false, show a subtle top banner: "You're offline. Changes will sync when you're back."
2. Logging mutations: when offline, TanStack Query pauses mutations. When back online, they resume automatically. The `clientEntryId` ensures idempotency — a retried log won't duplicate.
3. Read queries: stale data remains visible from the query cache. Pull-to-refresh shows a "No connection" toast instead of silently failing.
4. Navigation: all screens remain navigable offline. Only mutations and refreshes are affected.
5. Full sync queue with conflict resolution is deferred to M6. This ticket covers graceful degradation only.

**Acceptance:**

- [ ] Offline banner appears when disconnected
- [ ] Cached data remains visible
- [ ] A log made offline retries on reconnect and doesn't duplicate
- [ ] Pull-to-refresh while offline shows a clear message

---

## 5.15 — Settings screen (full)

**Goal:** expand the existing settings screen with account management and tower-related settings.

**Files:**

- Update `apps/mobile/app/(tabs)/settings.tsx`

**Work:**

1. Keep existing: user info card, push notification toggle, sign out, API URL debug info.
2. Add: timezone display with a note that it syncs from the device (read-only for now; `PATCH /me` with new timezone is M6).
3. Add: active sessions list from `GET /me/sessions`. Each row shows user agent and last seen. Current session highlighted. "Revoke all other sessions" button → `POST /auth/sessions/revoke-all`.
4. Add: app version and build number from Expo Constants.
5. Reorganise into sections: Account, Notifications, Sessions, About.

**Acceptance:**

- [ ] Sessions list shows active sessions with current session highlighted
- [ ] "Revoke all" works and signs out other sessions
- [ ] App version displayed
- [ ] Clean section layout
