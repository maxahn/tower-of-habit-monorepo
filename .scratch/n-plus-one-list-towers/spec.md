Status: done

# Fix N+1 Query in listTowersForUser

## Problem Statement

`listTowersForUser` loads the user's towers, then runs one `COUNT(*)` query per tower in a loop to get active member counts. For a user in N towers, this executes N+1 queries. The function's interface hides the cost — callers see a clean return type but pay O(N) database round trips. As users join more towers, `GET /towers` response time grows linearly with tower count.

## Solution

Replace the per-tower COUNT loop with a single query that joins towers to a grouped membership count. One round trip regardless of N. The function's interface stays identical — callers are unaffected.

## User Stories

1. As a mobile user with several towers, I want the tower list to load quickly, so that the app feels responsive.
2. As an operator, I want tower listing queries to scale with a constant number of round trips, so that database load is predictable.
3. As a developer, I want the member count to be fetched in the same query as the tower list, so that the function is self-contained and efficient.

## Implementation Decisions

- **Replace the loop with a subquery or lateral join.** The current code runs `for (const row of mine) { const [c] = await db.select({ n: count() }).from(memberships).where(...) }`. Replace with a single query that joins the user's towers to a grouped count of non-removed memberships. In Drizzle, this is a subquery or a `leftJoin` on a grouped membership count CTE.
- **Keep the function signature identical.** `listTowersForUser(db, userId)` returns the same `TowerWithMembership[]` shape. The member count field stays in the return type. No callers change.
- **Count only non-removed memberships**, matching the current `ne(memberships.state, 'removed')` filter.
- **Handle towers with zero active members.** Use a LEFT JOIN so towers with no non-removed memberships return `memberCount: 0` instead of being dropped.

## Testing Decisions

- The existing integration tests for `GET /towers` (in `apps/api/src/towers/routes.integration.test.ts`) verify that the endpoint returns correct tower data. If those tests include member count assertions, they serve as the regression test. If not, add one test that creates a tower with known members and asserts the count.
- Add a DB-level unit test in `packages/db/src/towers/towers.test.ts`: create a user in multiple towers with varying member counts, call `listTowersForUser`, and assert each tower's `memberCount` matches expectations.
- Prior art: existing `towers.test.ts` and `routes.integration.test.ts` patterns.

## Out of Scope

- Paginating the tower list. The current function returns all towers for a user, and that's fine at current scale (users are unlikely to be in hundreds of towers).
- Caching tower member counts. The count is cheap when fetched in one query.
- Changing the response shape of `GET /towers`. The API contract is unchanged.

## Further Notes

This is a quick win — small diff, no interface change, measurable improvement. The fix is entirely inside the `listTowersForUser` function, which is the definition of deepening: more capability (efficient batch fetch) behind the same interface.
