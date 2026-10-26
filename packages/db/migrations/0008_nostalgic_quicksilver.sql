CREATE TYPE "public"."freebie_source" AS ENUM('earned', 'host_granted', 'system');--> statement-breakpoint
CREATE TYPE "public"."period_outcome" AS ENUM('survived', 'collapsed', 'hibernated', 'freebie');--> statement-breakpoint
CREATE TYPE "public"."period_state" AS ENUM('pending', 'evaluating', 'evaluated');--> statement-breakpoint
CREATE TABLE "tower_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tower_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"evaluate_at" timestamp with time zone NOT NULL,
	"state" "period_state" DEFAULT 'pending' NOT NULL,
	"outcome" "period_outcome",
	"evaluated_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"freebie_source" "freebie_source",
	"freebie_granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tower_periods_tower_id_period_start_unique" UNIQUE("tower_id","period_start"),
	CONSTRAINT "tower_periods_end_after_start" CHECK ("tower_periods"."period_end" >= "tower_periods"."period_start"),
	CONSTRAINT "tower_periods_evaluate_after_deadline" CHECK ("tower_periods"."evaluate_at" >= "tower_periods"."deadline_at"),
	CONSTRAINT "tower_periods_outcome_iff_evaluated" CHECK (("tower_periods"."state" = 'evaluated') = ("tower_periods"."outcome" IS NOT NULL) AND ("tower_periods"."state" = 'evaluated') = ("tower_periods"."evaluated_at" IS NOT NULL)),
	CONSTRAINT "tower_periods_claimed_unless_pending" CHECK ("tower_periods"."state" = 'pending' OR "tower_periods"."claimed_at" IS NOT NULL),
	CONSTRAINT "tower_periods_attempts_nonnegative" CHECK ("tower_periods"."attempts" >= 0),
	CONSTRAINT "tower_periods_freebie_fields_iff_freebie" CHECK (("tower_periods"."outcome" IS NOT DISTINCT FROM 'freebie') = ("tower_periods"."freebie_source" IS NOT NULL)),
	CONSTRAINT "tower_periods_freebie_granted_by_requires_source" CHECK ("tower_periods"."freebie_granted_by" IS NULL OR "tower_periods"."freebie_source" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "tower_periods" ADD CONSTRAINT "tower_periods_tower_id_towers_id_fk" FOREIGN KEY ("tower_id") REFERENCES "public"."towers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tower_periods" ADD CONSTRAINT "tower_periods_freebie_granted_by_users_id_fk" FOREIGN KEY ("freebie_granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "periods_due" ON "tower_periods" USING btree ("state","evaluate_at") WHERE "tower_periods"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "periods_stale_claims" ON "tower_periods" USING btree ("claimed_at") WHERE "tower_periods"."state" = 'evaluating';--> statement-breakpoint
CREATE INDEX "tower_periods_freebie_granted_by_idx" ON "tower_periods" USING btree ("freebie_granted_by") WHERE "tower_periods"."freebie_granted_by" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "towers" ADD CONSTRAINT "towers_week_reset_day_range" CHECK ("towers"."week_reset_day" IS NULL OR "towers"."week_reset_day" BETWEEN 0 AND 6);