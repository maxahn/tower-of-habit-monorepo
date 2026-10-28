CREATE TYPE "public"."dormancy_reason" AS ENUM('consecutive_miss', 'backstop', 'voluntary');--> statement-breakpoint
CREATE TYPE "public"."membership_state" AS ENUM('active', 'at_risk', 'dormant', 'removed');--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tower_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"habit_id" uuid NOT NULL,
	"state" "membership_state" DEFAULT 'active' NOT NULL,
	"consecutive_missed_periods" integer DEFAULT 0 NOT NULL,
	"last_qualifying_date" date,
	"dormant_since" timestamp with time zone,
	"dormancy_reason" "dormancy_reason",
	"voluntary_return_date" date,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_tower_id_user_id_unique" UNIQUE("tower_id","user_id"),
	CONSTRAINT "memberships_missed_periods_nonnegative" CHECK ("memberships"."consecutive_missed_periods" >= 0),
	CONSTRAINT "memberships_dormancy_iff_dormant" CHECK (("memberships"."state" = 'dormant') = ("memberships"."dormant_since" IS NOT NULL AND "memberships"."dormancy_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tower_id_towers_id_fk" FOREIGN KEY ("tower_id") REFERENCES "public"."towers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_habit_id_habits_id_fk" FOREIGN KEY ("habit_id") REFERENCES "public"."habits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_tower_per_habit" ON "memberships" USING btree ("habit_id") WHERE "memberships"."state" != 'removed';--> statement-breakpoint
CREATE INDEX "memberships_user_id_idx" ON "memberships" USING btree ("user_id");