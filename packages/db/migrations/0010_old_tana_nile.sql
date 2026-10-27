-- push_tokens + notifications.
--
-- notifications.dedupe_key is why this migration exists. The evaluator is
-- idempotent and may re-run a period (3.5); that idempotency stops at the
-- database, because a push it already sent cannot be un-sent. So dispatch gets
-- idempotency of its own, keyed on the semantic EVENT rather than on the
-- evaluation that produced it, and notifications_dedupe_key_unique absorbs the
-- retried insert instead of letting it become a second collapse push.
--
-- There is deliberately NO period_id column. The period id lives INSIDE
-- dedupe_key as an opaque referent: tower_periods is prunable, and the key's
-- persistence IS the idempotency guarantee, so it must not be reachable by
-- another table's lifecycle. A CASCADE would delete the key and re-arm a
-- collapse that already went out. The dedupe scope also varies by type
-- (period / membership / block / tower), so the column would be NULL on most
-- rows. See src/notifications/schema.ts for the full argument.
--
-- notification_type omits tower_paused and tower_resumed: both are repeatable
-- with no stored occurrence instant to key them on, so a key would either
-- embed the clock (not idempotent) or suppress every pause after the first.
-- host_transferred is repeatable too, and is keyed on the current period for
-- exactly that reason.
--
-- The two iffs on notifications.status are SEPARATE constraints on purpose. One
-- combined form would accept a 'sent' row carrying an error and no sent_at,
-- because true = true -- the same hole tower_periods_outcome_iff_evaluated
-- splits itself to avoid.
--
-- push_tokens_token_trimmed uses a regex, not btrim(): single-argument btrim()
-- strips spaces and nothing else, so it would accept a trailing newline.

CREATE TYPE "public"."push_platform" AS ENUM('ios', 'android');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('nudge', 'wobble', 'collapse', 'dormant', 'returned', 'member_joined', 'tower_started', 'tower_archived', 'block_completed', 'host_transferred');--> statement-breakpoint
CREATE TABLE "push_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"platform" "push_platform" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	CONSTRAINT "push_tokens_token_unique" UNIQUE("token"),
	CONSTRAINT "push_tokens_token_length" CHECK (length("push_tokens"."token") BETWEEN 1 AND 512),
	CONSTRAINT "push_tokens_token_trimmed" CHECK ("push_tokens"."token" !~ '^\s|\s$'),
	CONSTRAINT "push_tokens_last_seen_not_before_created" CHECK ("push_tokens"."last_seen_at" >= "push_tokens"."created_at"),
	CONSTRAINT "push_tokens_invalidated_not_before_created" CHECK ("push_tokens"."invalidated_at" IS NULL OR "push_tokens"."invalidated_at" >= "push_tokens"."created_at")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tower_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"dedupe_key" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" "notification_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "notifications_dedupe_key_length" CHECK (length("notifications"."dedupe_key") BETWEEN 1 AND 200),
	CONSTRAINT "notifications_sent_at_iff_sent" CHECK (("notifications"."status" = 'sent') = ("notifications"."sent_at" IS NOT NULL)),
	CONSTRAINT "notifications_error_iff_failed" CHECK (("notifications"."status" = 'failed') = ("notifications"."error" IS NOT NULL)),
	CONSTRAINT "notifications_error_length" CHECK ("notifications"."error" IS NULL OR length("notifications"."error") BETWEEN 1 AND 2000),
	CONSTRAINT "notifications_attempts_nonnegative" CHECK ("notifications"."attempts" >= 0),
	CONSTRAINT "notifications_attempts_recorded_when_attempted" CHECK ("notifications"."status" NOT IN ('sent', 'failed') OR "notifications"."attempts" >= 1)
);
--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tower_id_towers_id_fk" FOREIGN KEY ("tower_id") REFERENCES "public"."towers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_tokens_user_id_idx" ON "push_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_due" ON "notifications" USING btree ("status","scheduled_for") WHERE "notifications"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "notifications_user_id_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_tower_id_idx" ON "notifications" USING btree ("tower_id");