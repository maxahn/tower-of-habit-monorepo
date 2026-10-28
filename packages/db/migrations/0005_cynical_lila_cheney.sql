CREATE TYPE "public"."tower_lifecycle" AS ENUM('draft', 'active', 'paused', 'archived');--> statement-breakpoint
CREATE TABLE "towers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"name" varchar(60) NOT NULL,
	"period_unit" "period_unit" DEFAULT 'day' NOT NULL,
	"period_length" integer DEFAULT 1 NOT NULL,
	"quota" integer DEFAULT 1 NOT NULL,
	"deadline_time" time NOT NULL,
	"timezone" text NOT NULL,
	"week_reset_day" smallint,
	"join_code" "citext" NOT NULL,
	"wobble_lead_minutes" integer DEFAULT 120 NOT NULL,
	"nudge_lead_minutes" integer DEFAULT 240 NOT NULL,
	"grace_window_minutes" integer DEFAULT 120 NOT NULL,
	"lifecycle" "tower_lifecycle" DEFAULT 'draft' NOT NULL,
	"height" integer DEFAULT 0 NOT NULL,
	"current_streak" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "towers_join_code_unique" UNIQUE("join_code"),
	CONSTRAINT "towers_quota_range" CHECK ("towers"."quota" >= 1 AND "towers"."quota" <= "towers"."period_length"),
	CONSTRAINT "towers_wobble_lead_range" CHECK ("towers"."wobble_lead_minutes" >= 0 AND "towers"."wobble_lead_minutes" < 1440),
	CONSTRAINT "towers_nudge_lead_range" CHECK ("towers"."nudge_lead_minutes" < 1440),
	CONSTRAINT "towers_nudge_before_wobble" CHECK ("towers"."nudge_lead_minutes" > "towers"."wobble_lead_minutes"),
	CONSTRAINT "towers_week_reset_day_iff_week" CHECK (("towers"."period_unit" = 'week') = ("towers"."week_reset_day" IS NOT NULL)),
	CONSTRAINT "towers_height_nonnegative" CHECK ("towers"."height" >= 0),
	CONSTRAINT "towers_current_streak_nonnegative" CHECK ("towers"."current_streak" >= 0),
	CONSTRAINT "towers_grace_window_range" CHECK ("towers"."grace_window_minutes" BETWEEN 0 AND 360)
);
--> statement-breakpoint
ALTER TABLE "towers" ADD CONSTRAINT "towers_host_id_users_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "towers_host_id_idx" ON "towers" USING btree ("host_id");