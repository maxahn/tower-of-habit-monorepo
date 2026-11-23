# Shield-based absence instead of budget-based absence

The original absence system gave each member a 28-day annual budget of voluntary absence days, tracked as a stored counter (`voluntaryAbsenceDaysUsed`) on the membership. We replaced this with a streak shield mechanic: active members who survive periods during another member's absence earn tower-wide shields (max 3) that auto-consume to prevent a future collapse. The budget counter is removed.

## Considered options

- **Budget-based (original):** Each member gets 28 days/year. Simple accounting but punitive — members who take breaks are penalized, and the remaining members get nothing for carrying the load. The budget creates a "use it or lose it" dynamic that doesn't match how real accountability groups work.
- **Shield-based (chosen):** Absences are unlimited in frequency (14-day cap per break, 1-period advance declaration required) but generate a shared reward for the members who keep going. This reframes absence from "you owe the group" to "the group banks goodwill." The shield mechanic gives remaining members a concrete, visible benefit.
- **No mechanic:** Just let members go dormant with no consequence or benefit. Too permissive — there's no incentive to keep going when the group is diminished.

## Consequences

- The evaluator needs to check shield count before declaring a collapse. A collapse with shields > 0 consumes one shield instead.
- A new `shieldCount` column on the towers table replaces `voluntaryAbsenceDaysUsed` on memberships.
- A new `shield_consumed` notification type is needed for push notifications.
- Cancelled absences still consumed the declaration (the advance-notice cost), but don't generate shields if no periods were survived during the absence.
