CREATE TABLE "habit_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"habit_id" uuid NOT NULL,
	"tier_index" smallint NOT NULL,
	"label" varchar(60) NOT NULL,
	"threshold_value" numeric,
	CONSTRAINT "habit_tiers_habit_id_tier_index_unique" UNIQUE("habit_id","tier_index"),
	CONSTRAINT "habit_tiers_tier_index_nonnegative" CHECK ("habit_tiers"."tier_index" >= 0)
);
--> statement-breakpoint
ALTER TABLE "habit_tiers" ADD CONSTRAINT "habit_tiers_habit_id_habits_id_fk" FOREIGN KEY ("habit_id") REFERENCES "public"."habits"("id") ON DELETE cascade ON UPDATE no action;