# Phase 5 — Tickets

Detailed specs for every M5 ticket. The plan and build order live in `phase-5-PLAN.md`.

> **Note:** The Habits tab lives under `app/(tabs)/index/` (making it the default home tab), not `app/(tabs)/habits/` as originally specced. All habit-related file paths below reflect the actual structure.

---

## 5.1 — Habit creation + tier ladder editor ✅

**Goal:** a user can create binary, numeric, and tiered habits from the Habits tab.

**Files:**

- `apps/mobile/app/(tabs)/index/create.tsx` — creation form
- `apps/mobile/app/(tabs)/index/edit.tsx` — edit form (reuses same pattern, `PATCH /habits/:id`)
- `apps/mobile/lib/hooks/use-habits.ts` — TanStack Query hooks (`useCreateHabit`, `useHabits`, `useHabit`, `useHabitEntries`, `useUpdateHabit`, `useArchiveHabit`)
- `apps/mobile/components/tier-ladder-editor.tsx` — reusable tier editor component

**Work:**

1. Habit creation screen uses react-hook-form + zodResolver with `createHabitRequestSchema` from shared.
2. Three habit types selectable at the top: binary, numeric, tiered (via `HabitType` from `@tower-of-habit/shared`).
3. Common fields: name (required), period unit (day/week), period length (default 1), quota (default 1 for daily).
4. Numeric-specific: unit label (e.g. "minutes", "pages"), threshold value for tier 0.
5. Tiered-specific: inline tier ladder editor. Start with one tier (label + threshold). "Add tier" button appends a row. Each row has label, threshold, and a delete button (minimum 1 tier). Thresholds must be strictly increasing — validated via `buildRequest()` before submit. Grilling fix Q10: threshold inputs always shown for tiered habits.
6. `useCreateHabit` mutation calls `POST /v1/habits` and invalidates the habits list query on success.
7. On success, navigate back via `router.back()`.
8. Edit screen (`edit.tsx`) allows updating name, unit, period, quota via `useUpdateHabit` (`PATCH /v1/habits/:id`). Type is read-only.

**Acceptance:**

- [x] All three habit types create successfully and appear in the list
- [x] Validation errors show inline (empty name, non-increasing thresholds, etc.)
- [x] The tier ladder enforces at least 1 tier and strictly increasing thresholds

---

## 5.2 — Habit list + standalone habit view ✅

**Goal:** the Habits tab shows all habits with type badges and period info; tapping one opens a detail screen with streak, entries, and actions.

**Files:**

- `apps/mobile/app/(tabs)/index/index.tsx` — habit list (FlatList)
- `apps/mobile/app/(tabs)/index/[id].tsx` — habit detail
- `apps/mobile/app/(tabs)/index/_layout.tsx` — stack navigator (index, create, [id], edit)
- `apps/mobile/lib/hooks/use-habits.ts` — `useHabit`, `useHabitEntries`

**Work:**

1. Habits tab is a stack navigator with four screens: index (list), create (modal), [id] (detail), edit (modal). Dark/light header colors via `useColorScheme`.
2. Habit list: `GET /v1/habits` → FlatList of `HabitRow` components. Each row shows name, type badge, period label, quota. Sorted: active first (alphabetical), archived last.
3. Pull-to-refresh on the list. Empty state with "Create Habit" CTA.
4. Habit detail screen: streak card (prominent), `LogEntry` component (from 5.3), habit info card (type, period, quota, unit), tier ladder, tower association, entry history (reverse-chronological FlatList). `EntryRow` subcomponent shows localDate, loggedAt, numericValue, tierReached, countsTowardQuota.
5. Edit button → navigates to `/index/edit` with pre-filled values (`useUpdateHabit`, `PATCH /v1/habits/:id`).
6. Archive action (confirmation Alert → `useArchiveHabit`, `POST /v1/habits/:id/archive`). Archived habits appear with an archived badge at the bottom of the list.

**Acceptance:**

- [x] Habits list loads, shows type/period per habit, supports pull-to-refresh
- [x] Tapping a habit opens detail with entry history
- [x] Edit and archive work end-to-end
- [x] Archived habits appear at the bottom with archived badge

---

## 5.3 — Logging: binary, numeric, tier picker ✅

**Goal:** the core action — logging an entry for a habit.

**Files:**

- `apps/mobile/components/log-entry.tsx` — logging UI component (binary button, numeric input, tier picker)
- `apps/mobile/lib/hooks/use-entries.ts` — `useLogEntry` mutation (entry list query lives in `use-habits.ts`)
- Integrated into `apps/mobile/app/(tabs)/index/[id].tsx`

**Work:**

1. `LogEntry` component takes `habit`, `tiers`, and optional `towerId` props. Renders inline on the habit detail screen above entry history. Only shown when habit is not archived.
2. Binary habits: single "Done" button, logs `tierReached: 0`.
3. Numeric habits: text input + "Log" button with `returnKeyType="done"` / `onSubmitEditing`. Shows threshold hint from first tier. Submits `numericValue`.
4. Tiered habits: sorted tier buttons, each logs `tierReached: tier.tierIndex` and optionally `numericValue: tier.thresholdValue`.
5. All branches generate a `clientEntryId` via `crypto.randomUUID()` for idempotency.
6. Optimistic mutation in `useLogEntry`: constructs an `EntryResponse` from request data, prepends to cached entry list. On error, rolls back to previous cache state.
7. On settle: invalidates `habitKeys.entries`, `habitKeys.detail`, and if `towerId` provided, `['towers', 'detail', towerId]`.
8. 1-second cooldown after successful log (button text changes to "Logged!").

**Acceptance:**

- [x] Binary, numeric, and tiered logging all work
- [x] Optimistic update: entry appears immediately, reverts on error
- [x] Double-tap produces one credit and no error toast
- [x] Streak updates after logging

---

## 5.4 — Tower creation + deadline picker ✅

**Goal:** a user can create a tower, selecting their habit, deadline time, timezone, and grace window.

**Files:**

- `apps/mobile/app/(tabs)/towers/create.tsx` — creation form
- `apps/mobile/components/deadline-picker.tsx` — custom hour/minute grid defaulting to 22:00
- `apps/mobile/lib/hooks/use-towers.ts` — `useCreateTower`, `useTowers`, `useEligibleHabits`

**Work:**

1. Tower creation form uses react-hook-form + zodResolver with `createTowerRequestSchema`.
2. Fields: name, habitId (picker from eligible habits), periodUnit (day/week), periodLength, quota, deadlineTime, graceWindowMinutes, weekResetDay (weekly only).
3. `DeadlinePicker`: custom tap-to-expand grid of 24 hours + 4 minute options (0, 15, 30, 45). Defaults to 22:00. Warns (amber text) if deadline is between midnight and 6 AM.
4. Wobble and nudge lead minutes: read-only display of defaults from shared (`DEFAULT_WOBBLE_LEAD_MINUTES`, `DEFAULT_NUDGE_LEAD_MINUTES`) in an expandable advanced section. Not user-editable.
5. `useCreateTower` calls `POST /v1/towers`, invalidates tower list + habit list. On success navigates to new tower's lobby via `router.replace('./${data.tower.id}')` (grilling fix Q3).
6. `useEligibleHabits`: fetches all habits, filters to `lifecycle === 'active'`, then fetches each detail to check `!d.tower`. Shows "Create Habit" button when no eligible habits exist, linking to `/(tabs)/index/create`.
7. Timezone auto-detected via `Intl.DateTimeFormat().resolvedOptions().timeZone`.

**Acceptance:**

- [x] Tower creates successfully with selected habit
- [x] Deadline defaults to 22:00, timezone to device timezone
- [x] Habit picker excludes habits already in a tower
- [x] No eligible habits → "Create a habit first" prompt

---

## 5.5 — Lobby: code sharing, member list, start ✅

**Goal:** the tower lobby screen where the host shares the join code and starts the tower.

**Files:**

- `apps/mobile/app/(tabs)/towers/[id]/index.tsx` — tower detail dispatcher (lobby or active, via `data.kind`)
- `apps/mobile/app/(tabs)/towers/[id]/_layout.tsx` — stack for tower sub-screens
- `apps/mobile/components/lobby.tsx` — lobby view component (has its own inline `MemberRow`, separate from `member-row.tsx`)

**Work:**

1. Tower detail screen fetches `GET /v1/towers/:id` via `useTower(id, { refetchInterval: 10_000 })` for 10-second auto-refresh (grilling fix Q2). Dispatches to `<Lobby>` or `<TowerHome>` based on `data.kind`.
2. Lobby view shows:
   - Tower name and settings summary (period, quota, deadline)
   - Join code formatted as `XXXX-XXXX` with Copy (`expo-clipboard`) and Share (native `Share.share`) buttons
   - Member list: each row shows display name, habit name, habit type badge (B/N/T). Host has a "Host" badge.
   - Host sees "Remove" button on each non-self member (with confirmation Alert → `useRemoveMember`, `DELETE /v1/towers/:id/memberships/:membershipId`)
   - Host sees "Start Tower" button (disabled until `members.length >= 2`, calls `useStartTower`, `POST /v1/towers/:id/start`)
3. Non-host members see "Leave Tower" button (confirmation Alert → `useLeaveTower`, navigates back to tower list).
4. All three mutations have `onError` handlers that show `Alert.alert('Error', err.message)` (grilling fix Q12).
5. Pull-to-refresh via ScrollView. After start, refetch switches view to active tower home.

**Acceptance:**

- [x] Join code displayed, copyable, shareable
- [x] Member list updates on pull-to-refresh and 10s auto-refresh
- [x] Host can remove members and start the tower (>= 2 members)
- [x] Non-host can leave
- [x] Starting transitions to the active tower view

---

## 5.6 — Join by code ✅

**Goal:** a user can join an existing tower by entering its join code.

**Files:**

- `apps/mobile/app/(tabs)/towers/join.tsx` — join screen (modal)
- `apps/mobile/lib/hooks/use-towers.ts` — `useJoinTower`, `useEligibleHabits`

**Work:**

1. Join screen presented as a modal from the towers list.
2. Code input with auto-formatting (`XXXX-XXXX`), strips non-alphanumeric, uppercases, 8-char limit.
3. Habit picker via `useEligibleHabits()` — same eligible-habits pattern as 5.4 with radio-button-style selection. If no eligible habits, shows warning card with "Create Habit" button linking to `/(tabs)/index/create`.
4. `useJoinTower` calls `POST /v1/towers/join` with `{ joinCode, habitId }`, invalidates `towerKeys.list()` and `habitKeys.list()`.
5. On success: `router.replace('./${data.tower.id}')` to go directly to the tower.
6. Error branching: 404 → "Invalid Code", 409 → "Already Joined", 429 → "Too Many Attempts", else generic.

**Acceptance:**

- [x] Can join a tower by code and see the lobby
- [x] Habit picker only shows eligible habits
- [x] Error states displayed clearly (invalid code, already joined, rate limited)

---

## 5.7 — Tower home: height, streak, members, period ✅

**Goal:** the active tower screen — the central view of the product.

**Files:**

- `apps/mobile/components/tower-home.tsx` — active tower view component
- `apps/mobile/components/member-row.tsx` — member status row (separate from lobby's inline MemberRow)
- `apps/mobile/app/(tabs)/towers/[id]/index.tsx` — dispatches to `<TowerHome>` when `kind: 'active'`

**Work:**

1. `TowerHome` takes `data: TowerActiveResponse` and `preview?: PeriodPreviewResponse`. `usePeriodPreview(id)` fetches `GET /v1/towers/:id/period` with 10s polling interval.
2. Header: tower name, three stats — streak (`currentStreak`), total height (`totalHeight()` sums `blocks[].blockHeight + currentStreak`), block count.
3. "Log" shortcut button: visible when user's `myMember.state` is `'active'` or `'at_risk'`, navigates to `/(tabs)/index/${myMember.habitId}`.
4. Period card: date range, deadline formatted with date+time, `PeriodStatusBadge` (open/wobbling/survived/collapsed) from preview.
5. `<Countdown deadlineAt={...} />` rendered below the period card (5.8).
6. Wobble warning card: amber-styled, shown when `preview.periodStatus === 'wobbling'`, lists outstanding members by name.
7. Members card: `<MemberRow>` for each member with display name, Host/You badges, habit name, state badge (active/at_risk/dormant with colored styling), standing indicator from preview (green checkmark for `'met'`, red X for `'short'`, blue dash for `'excused'`).
8. "View base blocks (N)" pressable at the bottom (navigation target not yet implemented — 5.10).
9. Pull-to-refresh reloads tower detail and period preview.

**Acceptance:**

- [x] Height and streak shown as two distinct numbers
- [x] Member states displayed correctly (active, at_risk, dormant)
- [x] Period info uses `deadlineAt` only
- [x] Pull-to-refresh works
- [x] "Log" shortcut navigates to the user's habit

---

## 5.8 — Countdown timer anchored to deadline_at ✅

**Goal:** a live countdown to the period deadline.

**Files:**

- `apps/mobile/components/countdown.tsx` — countdown component

**Work:**

1. `Countdown` component takes `{ deadlineAt: string }` (ISO timestamp).
2. Displays days (hidden if 0), hours, minutes, seconds — zero-padded, `tabular-nums` font. Updates every second via `useEffect` + `setInterval`.
3. Past-deadline state: shows "Past deadline — evaluating..." in a muted card instead of negative numbers.
4. Urgency tiers: normal (> 24h, plain), attention (1h–24h, amber border/bg), urgent (< 1h, red border/bg).
5. Colon separators between segments with matching urgency color.
6. Interval resets when `deadlineAt` prop changes and cleans up on unmount.

**Acceptance:**

- [x] Countdown ticks accurately against `deadlineAt`
- [x] Shows appropriate urgency styling
- [x] Cleans up interval on unmount
- [x] Never shows `evaluateAt`

---

## 5.9 — Tower animation (Reanimated)

**Goal:** a visual tower that grows with height and collapses visually.

**Prerequisites:** `react-native-reanimated` 4.7.1 is already in `apps/mobile/package.json`.

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

**Note:** `.scratch/future-features/issues/01-member-color-tower-visual.md` defers member-color tower visual to post-Phase 5.

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

**Note:** Tower home (5.7) already has a "View base blocks (N)" pressable but no navigation target yet.

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

**Prerequisites:** Backend absence redesign (`.scratch/absence-redesign/`) with 4 sub-issues (schema migration, evaluator shield logic, absence endpoint validation, shield notifications) must complete first. See ADR `docs/adr/0001-shield-based-absence.md`.

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

**Note:** The habits list (5.2) and towers list already have basic inline empty states with CTAs. This ticket extracts a reusable component and ensures consistent treatment across all screens.

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

**Existing work:** `apps/mobile/lib/online-manager.ts` already wires `@react-native-community/netinfo` into TanStack Query's `onlineManager`. Only the UI layer remains.

**Files:**

- `apps/mobile/components/offline-banner.tsx` — offline indicator
- `apps/mobile/lib/hooks/use-entries.ts` — update logging mutation for offline retry
- `apps/mobile/lib/online-manager.ts` — already exists, update if needed

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

**Existing work:** `apps/mobile/app/(tabs)/settings.tsx` already has user info card (name, email, timezone), push notification status/toggle, sign-out button, and API URL debug line.

**Files:**

- Update `apps/mobile/app/(tabs)/settings.tsx`

**Work:**

1. ~~Keep existing: user info card, push notification toggle, sign out, API URL debug info.~~ Already done.
2. Add: timezone display with a note that it syncs from the device (read-only for now; `PATCH /me` with new timezone is M6).
3. Add: active sessions list from `GET /me/sessions`. Each row shows user agent and last seen. Current session highlighted. "Revoke all other sessions" button → `POST /auth/sessions/revoke-all`.
4. Add: app version and build number from Expo Constants.
5. Reorganise into sections: Account, Notifications, Sessions, About.

**Acceptance:**

- [ ] Sessions list shows active sessions with current session highlighted
- [ ] "Revoke all" works and signs out other sessions
- [ ] App version displayed
- [ ] Clean section layout
