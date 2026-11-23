# Progress

**Next task:** 5.2 — Habit list + standalone habit view

**Blockers:** None.

## Done

- 5.1 Habit creation + tier ladder editor: Restructured Habits tab as stack navigator (`app/(tabs)/index/`). Added `react-hook-form` + `@hookform/resolvers`. Created `TierLadderEditor` component with add/remove tiers, threshold validation. Created habit creation screen with binary/numeric/tiered type selector, name, unit (numeric only), period, quota, and inline tier ladder editor. `useCreateHabit` TanStack Query mutation hook in `lib/hooks/use-habits.ts`.
