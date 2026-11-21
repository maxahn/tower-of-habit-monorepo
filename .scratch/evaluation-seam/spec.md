Status: done

# Fix Evaluation Cross-Package Seam Violation

## Problem Statement

The worker imports the evaluation I/O layer via a deep cross-package import: `import { createEvaluator } from '@tower-of-habit/api/src/evaluation/service.js'`. This reaches into the API app's internal source tree — not a published package export. The 13-line `evaluate.ts` shim in the worker exists only to re-type this import. Any change to the API's internal file layout breaks the worker at build time.

The evaluation logic has two layers: **pure rules** (already properly housed in `@tower-of-habit/shared/evaluator`) and **I/O** (load input from DB, persist results, enqueue notifications — all trapped inside `apps/api/src/evaluation/`). The worker needs the I/O layer, but it's not on a stable interface.

## Solution

Move the evaluation I/O layer to a shared location that both the API and worker can import from a stable package path. Delete the shallow `evaluate.ts` shim in the worker — it fails the deletion test.

## User Stories

1. As a developer refactoring the API's internal file structure, I want the worker to keep building, so that internal reorganization doesn't break a different app.
2. As a developer working on the worker, I want to import evaluation from a stable package path, so that I don't need to know the API's internal layout.
3. As a developer, I want the evaluation I/O module to have a clear owner (a package), so that changes to it are intentional cross-package decisions, not accidental side effects.
4. As a developer adding a new evaluation consumer (e.g., a CLI recompute tool), I want to import from the same stable interface, so that I don't create another deep cross-package import.
5. As a developer reading the worker code, I want it to be clear where evaluation logic comes from, so that I don't have to trace through a 13-line pass-through shim.

## Implementation Decisions

- **Option A (recommended): Re-export from the API package's entry point.** Add `createEvaluator` and its types to `@tower-of-habit/api`'s `package.json` exports. The worker then imports `from '@tower-of-habit/api/evaluation'` or similar. This is the smallest change: the code stays where it is, but the import path becomes a stable package contract. No new package to create or maintain.
- **Option B: Move to a new `packages/evaluation` package.** This makes the boundary explicit but adds a package to the monorepo. Worth it if the evaluation I/O layer grows or gets more consumers, but overkill today when there are exactly two consumers (API route handler, worker tick).
- **Delete `apps/worker/src/evaluate.ts`** — the 13-line shim that re-wraps `createEvaluator`. The worker's `index.ts` imports directly from the new stable path instead.
- **Delete the `TxRunner` type alias** in the shim — it's `{ transaction<T>(fn) }`, which is already the type of the `db` object both apps use.
- **Update the worker's `index.ts`** to import `createEvaluator` from the new path and call it directly in the tick loop wiring, replacing `createWorkerEvaluator`.
- The `EvaluateFn` type stays in `tick.ts` — it's the worker's own contract for what the tick loop calls, independent of where the implementation comes from.

## Testing Decisions

- **No new tests needed.** The existing evaluation integration tests (in `apps/api/src/evaluation/`) and worker integration tests (`suite.integration.test.ts`) verify the evaluator end-to-end. The change is a build-time seam fix, not a behavior change.
- Verify that `pnpm build` and `pnpm typecheck` pass across all workspaces after the import path change. This is the primary verification: if the worker compiles against the new path and existing tests pass, the seam is clean.
- If Option A: verify that the API's new export doesn't accidentally expose internal types that shouldn't be public.
- Prior art: the `@tower-of-habit/shared/evaluator` export is the pattern to follow — a sub-path export from a package.

## Out of Scope

- Restructuring the evaluation I/O layer itself. The code stays the same; only the import path changes.
- Moving the pure evaluation rules out of `@tower-of-habit/shared/evaluator`. They're already well-placed.
- Addressing the duplicated `resolvePeriodWindow` calls between sweep.ts and periods.ts. That's a separate candidate (#3 from the architecture review).

## Further Notes

Option A is recommended because it's the smallest diff that fixes the coupling. If a third consumer of the evaluation I/O layer appears, revisit Option B at that point — two adapters means a real seam (the codebase-design principle). Today there are exactly two, which is the threshold, not past it.
