# Tower of Habit — Screens & Flows

A complete reference for every screen, component, and user flow in the mobile app. Written for a UI builder who needs to understand what exists, how it connects, and what each screen does — without reading code.

---

## Table of Contents

1. [App Concept](#app-concept)
2. [Navigation Structure](#navigation-structure)
3. [Auth Flow](#auth-flow)
4. [Habits Tab (Home)](#habits-tab-home)
5. [Towers Tab](#towers-tab)
6. [Settings Tab](#settings-tab)
7. [Shared Components](#shared-components)
8. [API Reference](#api-reference)
9. [Data & State Patterns](#data--state-patterns)
10. [Design System](#design-system)
11. [Domain Glossary (Quick Reference)](#domain-glossary-quick-reference)

---

## App Concept

Tower of Habit is a social accountability app where small groups build a shared "tower" by maintaining personal habits together. Each member tracks their own habit (running, reading, meditating, etc.) and the tower grows by one unit of height each period (day or week) that everyone meets their commitment. If anyone misses, the tower **collapses** — the run resets, and the group starts over. The collapsed run is preserved as a **base block** (a geological layer in the tower's history).

Key tension: the tower is collective, but each habit is individual. You can't see who caused a collapse. The app never blames.

---

## Navigation Structure

```
Root Layout (_layout.tsx)
├── (auth) — unauthenticated screens
│   ├── login        — email entry
│   ├── verify       — OTP code entry
│   └── profile-setup — display name + timezone
│
└── (tabs) — authenticated, bottom tab bar
    ├── Habits tab (default home tab)
    │   ├── index      — habit list
    │   ├── [id]       — habit detail + logging
    │   ├── create     — new habit form
    │   └── edit       — edit habit form
    │
    ├── Towers tab
    │   ├── index      — tower list
    │   ├── create     — new tower form
    │   ├── join       — join by code (modal)
    │   └── [id]/
    │       ├── index  — tower detail (lobby OR active)
    │       └── history — base block strata view
    │
    └── Settings tab   — account, notifications, sessions
```

**Root routing logic:** The root layout checks for an authenticated session. If none exists, it renders the `(auth)` group. If authenticated, it renders `(tabs)`. The session is stored via a secure token and managed through TanStack Query.

**Tab bar:** Three tabs — Habits (home/default), Towers, Settings. Each tab has its own stack navigator so back-navigation works within each tab independently. Dark/light mode colors on all headers via `useColorScheme`. An `OfflineBanner` is rendered above the tab navigator (global, visible on all tabs when offline).

**Auth state routing:** `loading` → splash stays up. `authenticated` → shows tabs (redirects away from auth screens). `unauthenticated` → shows auth screens (redirects to login). `onboarding` → shows auth screens (redirects to profile-setup). Query cache is cleared on sign-out.

---

## Auth Flow

### Screen: Login (`(auth)/login.tsx`)

**Purpose:** Collect the user's email to send a one-time login code.

**Layout:**

- Centered vertically, horizontal padding
- App title "Tower of Habit" (h3, centered)
- Subtitle: "Sign in with your email to get started" (muted, centered)
- Labeled email text input (keyboard type: `email-address`, auto-capitalize: none, auto-correct: off, autocomplete: email)
- Error text displayed below input in destructive color
- Primary button: "Continue with email" / "Sending…" / "Resend in Ns" (30-second cooldown after successful send)

**Behavior:**

- Submit via button press or keyboard "go" action
- Calls `POST /v1/auth/request-code` with the trimmed email
- On success: starts 30-second cooldown, navigates to Verify screen passing email as param
- On error: contextual messages — 429 → rate limit, 422 → email undeliverable, network error → offline message, else generic
- No password, no social login — email OTP is the only auth method

**Validation:** Button disabled when loading, in cooldown, or email is blank.

---

### Screen: Verify (`(auth)/verify.tsx`)

**Purpose:** User enters the 6-digit OTP code sent to their email.

**Layout:**

- "← Back" pressable link at top (returns to login)
- "Check your email" heading (h3, centered) with the email address displayed below
- **6 individual digit input boxes** — each is a bordered, rounded box (h-14, w-11) with large bold centered text. Wrapped in an `Animated.View` for a shake effect on wrong codes.
- Error text (destructive, centered) below the inputs
- "Verify" / "Verifying…" primary button (disabled until all 6 digits filled)
- "Resend code" / "Resend code in Ns" pressable text (30-second cooldown, starts on mount)

**Input behavior:**

- First box auto-focused on mount
- Typing a digit auto-advances focus to the next box
- Backspace on an empty box moves focus back and clears the previous digit
- **Paste support:** pasting a full 6-digit string fills all boxes and auto-submits
- **Auto-submit:** when the last digit is entered, verification fires automatically
- iOS OTP autofill supported (`textContentType="oneTimeCode"`, `autoComplete="one-time-code"`)

**Verification behavior:**

- Calls `POST /v1/auth/verify-code` with `{ email, code, timezone }`
- On success: receives `{ token, expiresAt, user, isNewUser }`. If new user or `displayName === null` → Profile Setup. Otherwise → main app (Habits tab).
- On 401 (wrong code): increments fail counter, **shakes the input boxes** (translateX oscillation animation), clears all digits, re-focuses first box. After 5 consecutive failures → shows error and auto-redirects to login after 1.5 seconds.
- On 429 (rate limited): shows error and auto-redirects to login after 1.5 seconds.
- Resend: re-calls `POST /v1/auth/request-code` and resets the 30-second cooldown.

---

### Screen: Profile Setup (`(auth)/profile-setup.tsx`)

**Purpose:** First-time users set their display name and confirm timezone.

**Layout:**

- Centered vertically, horizontal padding
- "Set up your profile" heading with subtitle "Tell us a bit about yourself to get started"
- Labeled "Display name" input (autocapitalize: words, no autocorrect, placeholder: "What should we call you?")
- Inline validation: "At least 2 characters" shown when only 1 character entered
- Labeled "Timezone" input (read-only, auto-detected from device via `Intl.DateTimeFormat().resolvedOptions().timeZone`)
- Error text in destructive color
- "Get started" / "Saving…" primary button (disabled when name < 2 chars or loading)

**Behavior:**

- Submit via button or keyboard "done" action
- Calls `PATCH /v1/me` with `{ displayName, timezone }`
- On success: transitions auth state from `onboarding` → `authenticated`, root navigator redirects to tabs
- This screen is only shown once — subsequent logins skip it if the user already has a display name

---

## Habits Tab (Home)

This is the default landing tab. The core loop: create a habit → log entries → build streaks.

### Screen: Habit List (`(tabs)/habits/index.tsx`)

**Purpose:** Show all the user's habits at a glance.

**Layout:**

- List header row: "Habits" (h3) on the left, "+ New" outline button on the right (links to `/habits/create`)
- Scrollable list (FlatList) of habit card rows
- Pull-to-refresh supported

**Each habit row (pressable card):**

- Habit name (primary text, left side)
- Right chevron "›"
- Below name: type badge ("Binary" / "Numeric" / "Tiered" colored pill), period label (e.g., "Daily", "Weekly", "Every 2 weeks"), quota display
- Archived habits: "Archived" badge, entire row dimmed to 50% opacity

**Sorting:** Active habits first (alphabetical), archived habits last.

**Empty state:** Icon "🌱", title "Start with a habit", description text, CTA button "Create your first habit" linking to create screen.

**Navigation:** Tapping a habit card → Habit Detail screen (`/habits/[id]`).

---

### Screen: Habit Detail (`(tabs)/habits/[id].tsx`)

**Purpose:** The habit's home screen — view streak, log entries, see history.

**Layout (top to bottom):**

1. **Streak card** (prominent, top of screen)
   - Current streak number (large)
   - Computed client-side from consecutive qualifying entry dates

2. **Log Entry component** (inline, only shown for non-archived habits)
   - Varies by habit type — see [Log Entry Component](#log-entry-component) below

3. **Info card**
   - Type badge (+ "Archived" destructive badge if archived)
   - Period row (e.g., "Daily", "Weekly")
   - Quota row
   - Unit row (numeric habits only)

4. **Tiers card** (shown for numeric and tiered habits)
   - Each tier: index number, label, threshold value ("≥ N")

5. **Tower card** (shown if habit is linked to a tower)
   - Tower name, lifecycle state, membership state

6. **Action buttons row**
   - "Edit" button → navigates to edit screen (`/habits/edit?id=...`)
   - "Archive" button (only for non-archived habits) → confirmation alert ("Archive Habit"), destructive action. Disabled during mutation. On success, navigates back.

7. **Entry history** (reverse-chronological, rendered as FlatList items)
   - Each entry row shows:
     - Local date (e.g., "Nov 24, 2026")
     - Formatted date + time logged
     - For numeric: the value logged (e.g., "35 minutes")
     - For tiered: tier reached label
     - "Not counted" flag if `countsTowardQuota` is false
   - Empty state when no entries: "Log your first entry to start your streak."

**Pull-to-refresh:** Reloads habit detail and entries.

---

### Screen: Create Habit (`(tabs)/habits/create.tsx`)

**Purpose:** Form to create a new habit.

**Layout:**

1. **Habit type selector** (top of form, local state — not part of the form schema)
   - Three horizontally-laid toggle buttons:
     - **Binary** — "Did you do it?"
     - **Numeric** — "How much?"
     - **Tiered** — "Which level?"
   - Default: Binary. Switching to Binary resets any tier data.
   - Selecting a type shows/hides type-specific fields below

2. **Common fields:**
   - **Name** (required text input, 1–100 chars, placeholder "e.g. Morning run", autofocus)
   - **Period unit** — Day / Week toggle buttons
   - **Period length** + **Quota** — side-by-side numeric inputs (defaults: "1" and "1")

3. **Numeric-specific fields** (shown only when type = numeric):
   - **Unit label** (text input, e.g., "minutes", "pages", "km")
   - **Threshold value** for the base tier (number input, e.g., "30" minutes to count as done)

4. **Tiered-specific fields** (shown only when type = tiered):
   - **Tier ladder editor** — see [Tier Ladder Editor](#tier-ladder-editor) below
   - Starts with one tier row
   - "Add Tier" button to append more rows
   - Thresholds must be strictly increasing (validated before submit)

5. **Submit button:** "Create Habit" / "Creating…" (disabled while pending)

**Validation (runs in `buildRequest()` before submit):**

- Name is required (1–100 chars)
- Period length ≥ 1, quota ≥ 1
- For numeric: unit is required, all tiers need threshold values
- For tiered: at least 1 tier, all labels non-empty, thresholds strictly increasing
- Errors shown via `Alert.alert()`
- Uses `createHabitRequestSchema` from shared package via `zodResolver`

**Keyboard:** `KeyboardAvoidingView` + `keyboardShouldPersistTaps="handled"` for smooth input focus.

**Behavior:**

- On submit: `POST /v1/habits` → invalidates habit list → `router.back()`
- The created habit starts in `active` lifecycle state

---

### Screen: Edit Habit (`(tabs)/habits/edit.tsx`)

**Purpose:** Modify an existing habit's properties.

**Layout:** Same form layout as Create, with these differences:

- **Type is read-only** — displayed in a muted/grey box, capitalized text. Cannot change type after creation.
- Pre-filled with current habit values via `useHabit(id)`
- **No tier editing** — tiers are not editable after creation
- Name, unit (numeric), period, period length, and quota are all editable

**Submit:** "Save Changes" / "Saving…" → `PATCH /v1/habits/:id` → back to detail screen.

---

## Towers Tab

The social layer. Create or join a tower, then track the group's progress together.

### Screen: Tower List (`(tabs)/towers/index.tsx`)

**Purpose:** Show all towers the user belongs to.

**Layout:**

- Scrollable list (FlatList) of tower cards
- Pull-to-refresh supported

**Each tower card (pressable):**

- Tower name (left)
- Lifecycle status badge (right, colored pill: draft=blue, active=green, paused=amber, archived=grey)
- Metadata row below: Height value, Streak value, member count

**Empty states (two variants):**

- **No habits exist:** Icon "🏗️", title "Towers need habits", CTA linking to habit creation. (Can't create a tower without a habit.)
- **Has habits but no towers:** "Build a tower" title, two CTA buttons: "Create a tower" → `/towers/create`, "Join with a code" → `/towers/join`

**FAB cluster** (floating action buttons, shown when towers exist):

- Positioned absolute bottom-right (`bottom-8 right-6`)
- Two buttons: "Join" (outline style) and "+ New" (primary style)

**Navigation:** Tapping a tower card → Tower Detail screen (`/towers/[id]`).

---

### Screen: Create Tower (`(tabs)/towers/create.tsx`)

**Purpose:** Form to create a new tower and select the habit to contribute.

**Layout:**

1. **Tower name** (required text input, 1–100 chars, placeholder "e.g. Morning Crew", autofocus)

2. **Habit picker**
   - Shows only "eligible" habits: active lifecycle AND not already in another tower
   - Each habit shown as a selectable card with name, type badge, period info
   - Single-select with checkmark indicator on the selected card
   - If no eligible habits exist: warning card with "Create a habit first" button (links to habit creation)

3. **Period settings:**
   - **Period unit** — "Daily" / "Weekly" toggle chips
   - **Period length** + **Quota** — side-by-side numeric inputs

4. **Week reset day** (shown only when period unit = week)
   - Row of 7 day chips (Sun–Sat), single-select

5. **Deadline picker** (custom component — see [Deadline Picker](#deadline-picker))
   - Tap-to-expand grid: 24 hours × 4 minute slots (00, 15, 30, 45)
   - Default: 22:00
   - If time is between 00:00–05:59: amber warning text ("A deadline between midnight and 6 AM may be awkward for members in other timezones")

6. **Timezone** (auto-detected, displayed read-only with explanation text)

7. **Grace window** (minutes) — numeric input, default 120, with explanation text

8. **Advanced settings toggle** (collapsible section):
   - Wobble lead minutes (read-only, shows default value, "customization coming soon")
   - Nudge lead minutes (read-only, shows default value, "customization coming soon")

9. **Submit:** "Create Tower" / "Creating…" (disabled when pending or no habit selected)

**Validation (in `buildRequest()`):** Name required, periodLength ≥ 1, quota ≥ 1, quota ≤ periodLength, graceWindowMinutes ≥ 0, weekResetDay required for weekly.

**Behavior:**

- On submit: `POST /v1/towers` → navigates to the new tower's lobby via `router.replace('./${data.tower.id}')`
- Invalidates tower list and habit list queries (the selected habit is now tower-bound)
- Errors shown via `Alert.alert()`

---

### Screen: Join Tower (`(tabs)/towers/join.tsx`) — Modal

**Purpose:** Join an existing tower by entering the 8-character join code.

**Layout:**

1. **Code input**
   - Auto-formats as `XXXX-XXXX` (strips non-alphanumeric, uppercases)
   - 8-character limit
   - Large, centered text input

2. **Habit picker** (same eligible-habits pattern as Create Tower)
   - Radio-button style selection
   - If no eligible habits: warning card with "Create Habit" button

3. **Submit:** "Join Tower"

**Behavior:**

- On submit: `POST /v1/towers/join` with `{ joinCode, habitId }`
- On success: navigates to the tower detail via `router.replace`
- Error states displayed clearly:
  - 404 → "Invalid code — check the code and try again"
  - 409 → "You've already joined this tower"
  - 429 → "Too many attempts — please wait"

---

### Screen: Tower Detail (`(tabs)/towers/[id]/index.tsx`) — Dispatcher

**Purpose:** This screen fetches the tower data and renders either the **Lobby** view or the **Active Tower Home** view based on the tower's lifecycle state (`data.kind === 'lobby'` vs `'active'`).

**Polling:** Fetches `GET /v1/towers/:id` with a 10-second auto-refresh interval. This keeps the member list, period status, and tower state current without manual refresh.

---

### View: Lobby (`components/lobby.tsx`)

**Purpose:** Pre-start state where the host assembles members and shares the join code.

**Layout (top to bottom):**

1. **Tower info header**
   - Tower name
   - Settings summary: period type, quota, deadline time

2. **Join code card**
   - Code displayed large, formatted as `XXXX-XXXX`
   - "Copy" button (copies to clipboard via expo-clipboard)
   - "Share" button (opens native share sheet with the code)

3. **Member list** (titled "Members (N)")
   - Each row shows:
     - Display name
     - Badges: "Host" (blue pill), "You" (grey pill)
     - Habit type badge (B/N/T square) + habit name
   - **Host-only actions:** "Remove" button (destructive) on each non-self member row (with confirmation alert)

4. **Lone host guidance card** (shown when only 1 member)
   - Dashed border card: "Share the code to get started"
   - Prompts the host to share the join code before they can start

5. **Bottom actions (mutually exclusive based on role):**
   - **Host sees:** "Start Tower" button
     - Disabled until ≥ 2 members have joined
     - Shows "Need N more member(s)" when disabled
     - Calls `POST /v1/towers/:id/start`
     - On success: tower transitions to active, view switches to Tower Home
   - **Non-host sees:** "Leave Tower" button (destructive styling)
     - Confirmation dialog → `DELETE /v1/towers/:id/memberships/:membershipId`
     - Navigates back to tower list

**Pull-to-refresh:** Supported via ScrollView wrapping the content.

**Error handling:** All mutations (remove, start, leave) show `Alert.alert('Error', message)` on failure.

---

### View: Tower Home (`components/tower-home.tsx`)

**Purpose:** The central view of the product — the active tower's status, countdown, members, and period.

**Layout (top to bottom):**

1. **Tower animation** (`tower-visual.tsx` wrapped in `tower-visual-boundary.tsx`)
   - Visual stack of blocks representing the tower's height
   - Current run blocks in blue, base (historical) blocks in muted slate
   - New blocks animate in with a fade/slide entrance
   - On collapse: blocks fade/translate/scale down (all on UI thread via Reanimated)
   - Capped at 20 visible segments
   - Foundation line drawn at the base

2. **Header stats row** — three numbers:
   - **Streak** (current run height, `currentStreak`)
   - **Total height** (sum of all base block heights + current streak)
   - **Blocks** (number of completed base blocks / past runs)
   - Height and streak are always shown as two distinct numbers, never summed

3. **"Log" shortcut button**
   - Visible when the user's membership state is `active` or `at_risk`
   - Navigates directly to the user's habit detail screen (where they can log)
   - Not shown for dormant members

4. **Period card**
   - Date range (period start → period end)
   - Deadline date and time (formatted)
   - Period status badge: "Open", "Wobbling", "Survived", "Collapsed"
   - **Only `deadlineAt` is ever displayed; `evaluateAt` never appears in the UI**

5. **Countdown timer** (see [Countdown Component](#countdown-component))
   - Live countdown to `deadlineAt`
   - Urgency styling changes as deadline approaches

6. **Own membership state warnings** (conditional, shown when applicable):
   - **At risk** (amber card): "You are at risk — Missing the next period will make you dormant"
   - **Dormant** (zinc/grey card): "You are dormant — Your entries no longer count toward the tower"

7. **Solo-active warning** (conditional)
   - Shown when `soloActive: true` in the API response
   - Orange informational card: "You're the only active member — Everyone else is dormant. If you miss a period, the tower collapses."

8. **Wobble warning card** (conditional)
   - Shown when `periodStatus === 'wobbling'` and there are outstanding members
   - Amber-styled warning card: "Waiting on N members"
   - Lists the names of members who haven't yet met their quota for this period

9. **Members card**
   - Each member row (`member-row.tsx`) shows:
     - Display name
     - Badges: "Host" (if tower creator), "You" (if current user)
     - Habit name
     - **State badge** with colored styling:
       - `active` — green, default
       - `at_risk` — amber/yellow, "At risk"
       - `dormant` — grey, with dormancy reason (consecutive miss / backstop / voluntary) and dormant-since date
     - **Standing indicator** from period preview:
       - Green checkmark = "met" quota for current period
       - Red X = "short" of quota
       - Blue dash = "excused" (dormant member)
     - If member has a declared absence: "Returns [date]" shown on their row, row visually greyed

10. **Absence controls** (for the current user, see [Absence Controls](#absence-controls))
    - "Declare Absence" button with date picker
    - Or "Cancel Absence" if one is active

11. **"View base blocks (N)"** pressable at the bottom
    - Shows the count of completed base blocks
    - Navigates to the History (strata) screen

**Pull-to-refresh:** Reloads tower detail and period preview.

---

### Screen: History / Strata View (`(tabs)/towers/[id]/history.tsx`)

**Purpose:** A geological view of the tower's history — each past run is a "stratum" (layer).

**Layout:**

1. **Current run card** (top, special styling)
   - "Current Run" label
   - Live height (current streak value)
   - Start date
   - Distinct from base blocks — this run hasn't ended yet

2. **Base block list** (FlatList, newest first)
   - Each block row (`strata-block.tsx`) shows:
     - Run label: "Run #N" (using the block's ordinal)
     - Block height (how many periods that run lasted)
     - Date range: start date → end date
     - Member count from roster
   - **Tap to expand:** reveals the full roster for that run
     - Each roster entry: member display name + "qualifying_days / total_days (percentage%)" + dormant badge if applicable
   - Expandable/collapsible (tap again to collapse)

3. **Empty state:** "No previous runs yet — this is your tower's first attempt."
   - Shown when there are zero base blocks (the tower hasn't collapsed yet)

---

## Settings Tab

### Screen: Settings (`(tabs)/settings.tsx`)

**Purpose:** Account management, notification preferences, session management, and app info.

**Layout:** ScrollView with bordered card sections.

1. **Profile card:**
   - **View mode:** display name, email, timezone. "Edit" link in top-right corner.
   - **Edit mode** (toggled by "Edit"):
     - Display name input (pre-filled, min 2 chars inline validation)
     - Timezone input (read-only, device-detected). Hint: "Detected from your device. Change your device timezone to update."
     - Error text
     - "Cancel" (outline) and "Save" / "Saving…" buttons side-by-side
     - Calls `PATCH /v1/me` with `{ displayName }`

2. **Notifications card:**
   - Shows current push permission status with contextual UI:
     - `granted` → "Push notifications are enabled" (no action needed)
     - `denied` → "Push notifications are blocked in system settings" + "Open settings" button (opens OS app settings)
     - `undetermined` → "Push notifications have not been set up" + "Turn on" button (triggers OS permission prompt, then registers token with API)
   - Refreshes push status on mount and when app returns to foreground

3. **Active Sessions card:**
   - Loading spinner until data loads
   - Lists all sessions: device label ("This device" for current session, or user agent string), last seen date
   - Current session gets a "Current" badge (blue pill)
   - If other sessions exist: separator + "Sign out other devices" / "Signing out…" button
   - Revoke: confirmation alert → `POST /v1/auth/sessions/revoke-all` → reloads session list
   - Error state: "Could not load sessions."

4. **Sign Out button** (destructive styling)
   - Confirmation alert: "Sign out? You will need to sign in again to use the app." → Cancel / "Sign out" (destructive)
   - Calls `signOut()` → clears session → returns to login screen

5. **About footer:**
   - Centered text: "Tower of Habit v{appVersion}" (from Expo config)

---

## Shared Components

### Log Entry Component (`components/log-entry.tsx`)

Inline logging UI that appears on the Habit Detail screen. Adapts to habit type:

**Binary habits:**

- Single "Done" button
- Tap → logs `tierReached: 0`
- After success: button text changes to "Logged!" for 1 second (cooldown)

**Numeric habits:**

- Instructional text: "Log ≥ N {unit} to qualify" (shown if threshold exists)
- Numeric text input + "Log" button in a horizontal row (keyboard type: numeric)
- `returnKeyType="done"` and `onSubmitEditing` for keyboard submit
- Validates input is a finite number before submit
- Submits the `numericValue`

**Tiered habits:**

- "Select your tier" header text
- List of tier cards (pressable), each showing:
  - Tier index in a small circle
  - Tier label (e.g., "Bronze", "Silver", "Gold")
  - Threshold value ("≥ N") if present
  - Active press state visual feedback
- Tap → logs `tierReached: tierIndex` and `numericValue: thresholdValue`

**All types:**

- Generate a `clientEntryId` (UUID) for idempotency — prevents duplicate entries on retry
- **Optimistic update:** entry appears in the list immediately; rolls back on server error
- After logging: invalidates habit entries, habit detail, and associated tower detail queries
- Not shown when the habit is archived

---

### Countdown Component (`components/countdown.tsx`)

Live countdown to the tower's period deadline.

**Display:** `DDd HHh MMm SSs` — days (hidden if 0), hours, minutes, seconds. Zero-padded, monospace/tabular-nums font. Colon separators between segments.

**Urgency tiers:**

| Condition            | Style                                   |
| -------------------- | --------------------------------------- |
| > 24 hours remaining | Normal — plain card, no special color   |
| 1–24 hours remaining | Attention — amber border and background |
| < 1 hour remaining   | Urgent — red border and background      |

**Past-deadline state:** When countdown reaches zero, displays "Past deadline — evaluating..." in a muted card instead of negative numbers.

**Technical:** Ticks via `setInterval` at 1 second. Interval resets when `deadlineAt` prop changes. Cleans up on unmount.

---

### Deadline Picker (`components/deadline-picker.tsx`)

Custom time picker for tower creation.

**Layout:** Tap-to-expand. When collapsed, shows the selected time (e.g., "22:00"). When expanded:

- Grid of 24 hours (0–23)
- For each hour: 4 minute options (00, 15, 30, 45)
- Tap to select a time slot

**Default:** 22:00.

**Warning:** If selected time falls between 00:00–06:00, shows amber warning text: "Late-night deadlines can be easy to miss."

---

### Tier Ladder Editor (`components/tier-ladder-editor.tsx`)

Inline editor for tiered habit tiers, used in Create and Edit Habit screens.

**Layout:**

- List of tier rows, each with:
  - Tier label (text input, e.g., "Bronze")
  - Threshold value (number input, e.g., "10")
  - Delete button (trash icon, hidden when only 1 tier remains)
- "Add Tier" button at the bottom

**Validation:**

- Minimum 1 tier (delete button hidden on last remaining tier)
- Labels must be non-empty
- Threshold values must be strictly increasing (validated before form submit)
- Thresholds are always shown for tiered habits

---

### Member Row (`components/member-row.tsx`)

Reusable row for displaying a tower member's status.

**Layout:**

- Display name (primary text)
- Badges: "Host" (if tower creator), "You" (if current user)
- Habit name (secondary text)
- State badge with colored styling:
  - `active` — green
  - `at_risk` — amber/yellow
  - `dormant` — grey, with reason text and dormant-since date
- Standing indicator from period preview:
  - Green checkmark = "met"
  - Red X = "short"
  - Blue dash = "excused"
- If member has a declared absence with a return date: "Returns [date]" text, row visually greyed out

---

### Absence Controls (`components/absence-controls.tsx`)

UI for the current user to declare or cancel a voluntary absence from a tower.

**Two states:**

**Active absence** (blue-bordered card):

- "Absence active" label
- Shows return date
- "Cancel absence" button with confirmation alert
- On confirm: `DELETE /towers/:id/absence`

**Declare absence** (card with controls):

- Annual budget display: "N of 28 annual days remaining"
- If budget exhausted: red warning text "Annual absence budget exhausted" — no controls shown
- Otherwise: grid of day-count chips (1d, 2d, 3d, … up to min(14, daysRemaining))
  - Selected chip highlighted in primary color
- Summary text: "Absent N days · returns MMM d"
- "Confirm absence" button
- On submit: `POST /towers/:id/absence`

---

### Tower Visual (`components/tower-visual.tsx`)

Animated visual representation of the tower.

**Visual structure:**

- Stacked block segments representing tower height
- Current run blocks: blue
- Base (historical) blocks: muted slate
- Maximum 20 visible segments (older blocks scroll off or compress)
- Foundation line at the bottom

**Animations (via react-native-reanimated):**

- New blocks: `FadeIn` with `Easing.out(Easing.cubic)`
- Collapse: blocks fade out, translate downward, and scale down
- All animations run on the UI thread for 60fps

**Dark mode:** Colors adapt via `useColorScheme`.

**Architecture:** Wrapped in `tower-visual-boundary.tsx` — a swappable boundary component. The plan is to replace the Reanimated renderer with Skia in a future phase without touching the tower home screen.

---

### Strata Block (`components/strata-block.tsx`)

Two sub-components:

**StrataBlock** — a pressable card for a historical base block:

- Collapsed view: "Run #N", date range (start – end), block height (large bold), member count
- Expanded view (tap to toggle): roster table — each member's display name + "qualifying_days / total_days (percentage%)" + dormant badge if applicable

**CurrentRunCard** — a blue-bordered card for the active run:

- "Current run" label, "In progress" indicator
- Current streak number (large bold)
- Member count

---

### Empty State (`components/empty-state.tsx`)

Reusable empty state component used across list screens.

**Props:** `icon` (emoji string, rendered at 5xl), `title` (h4), `description` (muted), `children` (optional slot for CTA buttons)

**Layout:** Centered vertically — large emoji icon, title below, muted description, then optional children.

**Instances used across the app:**

- Habits list: 🌱 "Start with a habit" → "Create your first habit" CTA
- Towers list (no habits): 🏗️ "Towers need habits" → CTA to create habit
- Towers list (no towers): 🏗️ "Build a tower" → "Create a tower" + "Join with a code" CTAs
- Habit detail (no entries): "Log your first entry to start your streak."
- Tower history (no blocks): "First attempt" — explains base blocks appear after collapse and rebuild

---

### Offline Banner (`components/offline-banner.tsx`)

Shown when the device has no network connection.

**Layout:** Amber banner rendered above the tab navigator (in `(tabs)/_layout.tsx`), only visible when offline.

**Content:** "You're offline" + pending mutation count (e.g., "2 changes pending") or "changes will sync when you reconnect" if none pending.

**Behavior:**

- Appears when `onlineManager.isOnline()` returns false (via `@react-native-community/netinfo`)
- All screens remain navigable offline
- Cached data remains visible from the query cache
- Mutations (logging, etc.) pause and resume automatically when connectivity returns
- `clientEntryId` ensures retried logs don't duplicate
- Pull-to-refresh while offline shows a "No connection" indicator

---

## API Reference

All endpoints are under `/v1/`. Authenticated endpoints require a session token in the `Authorization: Bearer` header.

### Auth (public)

| Method | Path                        | Purpose                                                |
| ------ | --------------------------- | ------------------------------------------------------ |
| POST   | `/auth/request-code`        | Send OTP to email (always 202, no account enumeration) |
| POST   | `/auth/verify-code`         | Verify OTP → `{ token, expiresAt, user, isNewUser }`   |
| POST   | `/auth/refresh`             | Rotate session token                                   |
| POST   | `/auth/logout`              | Revoke current session                                 |
| POST   | `/auth/sessions/revoke-all` | Revoke all sessions                                    |

### Profile

| Method | Path           | Purpose                              |
| ------ | -------------- | ------------------------------------ |
| GET    | `/me`          | Current user + active tower count    |
| PATCH  | `/me`          | Update display name, timezone        |
| GET    | `/me/sessions` | List active sessions (marks current) |

### Habits

| Method | Path                  | Purpose                                                              |
| ------ | --------------------- | -------------------------------------------------------------------- |
| POST   | `/habits`             | Create habit (discriminated by type: binary/numeric/tiered)          |
| GET    | `/habits`             | List all habits                                                      |
| GET    | `/habits/:id`         | Detail: habit + tiers + currentStreak + tower association            |
| PATCH  | `/habits/:id`         | Update name, unit, period, quota (cadence locked if in active tower) |
| PUT    | `/habits/:id/tiers`   | Replace tier ladder                                                  |
| POST   | `/habits/:id/archive` | Archive habit (blocked if in active tower)                           |

### Entries

| Method | Path                  | Purpose                                                                       |
| ------ | --------------------- | ----------------------------------------------------------------------------- |
| POST   | `/entries`            | Log entry (`clientEntryId` for idempotency) → `{ entry, qualifies, created }` |
| GET    | `/habits/:id/entries` | List entries for a habit                                                      |

### Towers

| Method | Path                           | Purpose                                                                 |
| ------ | ------------------------------ | ----------------------------------------------------------------------- |
| POST   | `/towers`                      | Create tower (starts in lobby/draft)                                    |
| GET    | `/towers`                      | List user's towers                                                      |
| GET    | `/towers/:id`                  | Tower detail — discriminated union: `kind: 'lobby'` or `kind: 'active'` |
| POST   | `/towers/join`                 | Join by code + habit selection                                          |
| DELETE | `/towers/:id/memberships/:mid` | Leave (self) or remove (host, lobby only)                               |
| POST   | `/towers/:id/start`            | Start tower (host only, ≥ 2 members)                                    |
| GET    | `/towers/:id/period`           | Live period preview (standings, countdown, status)                      |
| POST   | `/towers/:id/absence`          | Declare voluntary absence (from/to dates)                               |
| DELETE | `/towers/:id/absence`          | Cancel active absence                                                   |

### Push Tokens

| Method | Path           | Purpose                         |
| ------ | -------------- | ------------------------------- |
| POST   | `/push-tokens` | Register/upsert Expo push token |

### Key Response Shapes

**Tower detail** is a discriminated union on `kind`:

- `lobby` → `{ kind, tower (with joinCode), members, role ("host"/"member") }`
- `active` → `{ kind, tower, members, role, currentPeriod, blocks, soloActive }`

**Period preview** → `{ period, periodStatus ("open"/"wobbling"/"survived"/"collapsed"), members (with standing: "met"/"short"/"excused"), outstanding, height, currentStreak, soloActive }`

**Member standing** → `met` (green), `short` (red), `excused` (blue)

**Membership states** → `active`, `at_risk`, `dormant`, `removed`

---

## Data & State Patterns

### API Communication

- All API calls go through a central `api-client.ts` using `fetch`
- Base URL auto-detected: LAN IP for physical devices, localhost for simulators
- Session token attached as an auth header

### State Management

- **TanStack Query (React Query)** for all server state
- Queries auto-refetch on focus and on reconnect
- Tower detail polls every 10 seconds for real-time group status
- Habit/tower lists refetch on pull-to-refresh

### Optimistic Updates

- Entry logging uses optimistic mutations: the entry appears in the UI immediately, then rolls back if the server rejects it
- `clientEntryId` (UUID) is generated client-side and sent with each log for idempotency

### Offline Strategy

- TanStack Query's `onlineManager` wired to NetInfo
- Mutations pause when offline, resume when online
- Cached data remains visible
- Full sync queue with conflict resolution is planned for a future phase

### Form Validation

- Shared Zod schemas from `@tower-of-habit/shared` used for client-side validation
- `zodResolver` with `react-hook-form` on all create/edit forms
- Identical schemas used on the server — validation rules can't drift

### Push Notifications

- Expo Push Notifications for delivery
- Token registered with the server on app launch
- Notification types: nudge, wobble, collapse, at_risk, dormant, hibernate, shield_consumed

---

## Design System

### Stack

- **NativeWind 4.2.7** — Tailwind CSS compiled to React Native styles via `className` props
- **class-variance-authority (CVA)** — declarative component variant definitions
- **clsx + tailwind-merge** — `cn()` helper in `lib/utils.ts` for conditional class merging
- **@rn-primitives** — headless primitives for Label, Separator, Slot (RN equivalent of Radix)
- **react-native-reanimated 4.7.1** — UI-thread animations (tower visual, OTP shake)
- **System fonts only** — no custom fonts loaded

This is the **shadcn/ui pattern ported to React Native**: unstyled primitives composed with Tailwind classes, no component library to eject from.

### Color Tokens

All colors are HSL CSS custom properties defined in `global.css`, resolved via `hsl(var(--token))`.

| Token                                  | Light                      | Dark                               |
| -------------------------------------- | -------------------------- | ---------------------------------- |
| `--background`                         | white (0 0% 100%)          | near-black (240 10% 4%)            |
| `--foreground`                         | near-black (240 10% 4%)    | near-white (0 0% 98%)              |
| `--primary`                            | blue #2563eb (221 83% 53%) | lighter blue #3b82f6 (217 91% 60%) |
| `--primary-foreground`                 | white                      | white                              |
| `--destructive`                        | red #ef4444 (0 84% 60%)    | deeper red (0 72% 51%)             |
| `--secondary` / `--muted` / `--accent` | light grey (240 5% 96%)    | dark grey (240 4% 16%)             |
| `--muted-foreground`                   | medium grey (240 4% 46%)   | medium grey (240 5% 65%)           |
| `--border` / `--input`                 | light grey (240 6% 90%)    | dark grey (240 4% 16%)             |
| `--card`                               | white                      | near-black                         |
| `--ring`                               | same blue as primary       | same blue as primary               |

Beyond these semantic tokens, feature components use Tailwind's built-in palette directly: `blue-400`/`blue-500` for tower blocks, `amber-*` for warnings, `slate-*` for base blocks, `red-*` for urgency, `green-*` for success states.

### Dark Mode

- Tailwind config: `darkMode: 'class'` — NativeWind applies a `.dark` class to the root
- `global.css` defines `:root` (light) and `.dark` (dark) CSS variable sets
- `useColorScheme()` hook wraps NativeWind's hook; returns `colorScheme`, `isDark`, `setColorScheme`, `toggleColorScheme`
- Components use `dark:` prefixed classes (e.g., `dark:bg-input/30`, `dark:border-input`)
- Stack/tab headers set their background and tint colors manually from `isDark` in each `_layout.tsx`

### UI Primitives (`components/ui/`)

| Component     | Variants                                                                                                                                                                                                                                                 | Key details                                                                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Button**    | default (primary bg), destructive (red), outline (bordered), secondary (muted bg), ghost (transparent), link (underline on press) × sizes: sm (h-9), default (h-10), lg (h-11), icon (h-10 w-10)                                                         | `Pressable`. Injects text color via `TextClassContext` so child `<Text>` auto-inherits button-variant colors. Disabled → 50% opacity.                                                                |
| **Card**      | —                                                                                                                                                                                                                                                        | `View` with `bg-card border rounded-xl py-6 shadow-sm`. Sub-components: CardHeader (px-6 gap-1.5), CardTitle (semibold), CardDescription (muted sm), CardContent (px-6), CardFooter (px-6 flex-row). |
| **Input**     | —                                                                                                                                                                                                                                                        | `TextInput` — h-10, rounded-md, bordered, shadow-sm. Dark: `bg-input/30`. Disabled: 50% opacity. Placeholder: `--muted-foreground`.                                                                  |
| **Text**      | h1 (4xl/extrabold), h2 (3xl/semibold + bottom border), h3 (2xl/semibold), h4 (xl/semibold), p (leading-7), lead (xl muted), large (lg semibold), small (sm medium), muted (sm muted-foreground), code (mono sm bg-muted), blockquote (italic border-l-2) | Reads `TextClassContext` for inherited color (from Button/Card). Sets ARIA roles/levels for headings.                                                                                                |
| **Label**     | —                                                                                                                                                                                                                                                        | Semibold sm text. Wraps `@rn-primitives/label`. Disabled: 50% opacity.                                                                                                                               |
| **Separator** | horizontal, vertical                                                                                                                                                                                                                                     | 1px line in `bg-border`.                                                                                                                                                                             |

### Typography Scale

System fonts, Tailwind default sizes:

| Variant | Size        | Weight              | Notes                         |
| ------- | ----------- | ------------------- | ----------------------------- |
| h1      | 4xl (36px)  | extrabold (800)     | centered, tracking-tight      |
| h2      | 3xl (30px)  | semibold (600)      | tracking-tight, bottom border |
| h3      | 2xl (24px)  | semibold (600)      | tracking-tight                |
| h4      | xl (20px)   | semibold (600)      | tracking-tight                |
| base    | base (16px) | normal (400)        | default body text             |
| lead    | xl (20px)   | normal, muted       | subtitle / intro text         |
| large   | lg (18px)   | semibold (600)      |                               |
| small   | sm (14px)   | medium (500)        |                               |
| muted   | sm (14px)   | normal, muted color | secondary text                |

`tabular-nums` font variant used specifically in the countdown component for stable-width digits.

### Spacing, Radius, and Sizing Conventions

- **Spacing:** Tailwind 4px grid. Common values: `gap-2` (8px), `gap-6` (24px), `px-3` (12px), `px-6` (24px), `py-6` (24px for cards).
- **Border radius:** `rounded-md` (6px) for buttons/inputs, `rounded-xl` (12px) for cards, `rounded-sm` (2px) for tower block segments.
- **Heights:** `h-10` (40px) default controls, `h-9` (36px) small, `h-11` (44px) large.
- **Shadows:** `shadow-sm shadow-black/5` on most interactive elements (subtle).
- **Opacity:** Disabled elements → `opacity-50`. Dormant member rows → 50%. Archived habits → 50%.
- **Cards:** Consistent `border py-6 rounded-xl` with `px-6` on header/content/footer sub-views and `gap-6` between sections.

---

## Domain Glossary (Quick Reference)

| Term                  | Meaning                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Tower**             | A shared structure built by a group, each contributing through their own habit                                           |
| **Run**               | A consecutive sequence of survived periods; ends on collapse                                                             |
| **Run height**        | Periods survived in the current run (resets on collapse)                                                                 |
| **Total height**      | Cumulative periods survived across all runs (never resets)                                                               |
| **Base block**        | A frozen record of a completed (collapsed) run                                                                           |
| **Collapse**          | When a live member fails quota; ends the run, creates a base block. Never attributed to an individual.                   |
| **Period**            | A recurring time window (day or week) during which members must meet quota                                               |
| **Host**              | The member who created the tower; can remove members and start the tower                                                 |
| **Lobby**             | Pre-start state where the host assembles members via join code                                                           |
| **Dormant**           | A member excused from quota obligations (consecutive miss, backstop, or voluntary absence)                               |
| **Streak shield**     | Tower-wide buffer earned when active members survive during another's absence; auto-consumes to prevent collapse (max 3) |
| **Absence**           | A declared break from a tower; max 14 days, must declare one period in advance                                           |
| **Habit types**       | Binary (done/not done), Numeric (value vs. threshold), Tiered (multiple named levels)                                    |
| **Period unit**       | Day or Week                                                                                                              |
| **Membership states** | active, at_risk, dormant, removed                                                                                        |
