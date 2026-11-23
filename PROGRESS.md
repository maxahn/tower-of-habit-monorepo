# Progress

**Next task:** 5.3 — Logging: binary, numeric, tier picker

**Blockers:** None.

## Done

- 5.2 Habit list + standalone habit view: Rewrote habits index as FlatList with type badges, period info, archived-at-bottom sorting, pull-to-refresh. Added `[id].tsx` detail screen with streak card, habit info, tier ladder, tower association, entry history (reverse-chronological), edit/archive actions. Added `edit.tsx` modal for updating habit fields (name, unit, period, quota) via `PATCH /habits/:id`. Added `useHabitEntries`, `useUpdateHabit`, `useArchiveHabit` hooks. Archive shows confirmation dialog.
- 5.1 Habit creation + tier ladder editor: Restructured Habits tab as stack navigator (`app/(tabs)/index/`). Added `react-hook-form` + `@hookform/resolvers`. Created `TierLadderEditor` component with add/remove tiers, threshold validation. Created habit creation screen with binary/numeric/tiered type selector, name, unit (numeric only), period, quota, and inline tier ladder editor. `useCreateHabit` TanStack Query mutation hook in `lib/hooks/use-habits.ts`.
