Status: open
Type: task
Blocked by: 02

# Add shield_consumed push notification

1. Add `shield_consumed` notification type
2. Worker sends push notification to all tower members when a shield prevents a collapse
3. Notification copy: "A streak shield protected [tower name] — [N] shields remaining"
4. Dedupe key: `shield_consumed:{towerId}:{periodId}`
