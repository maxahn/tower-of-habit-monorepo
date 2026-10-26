CREATE TABLE "entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"habit_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"tier_reached" smallint DEFAULT 0 NOT NULL,
	"numeric_value" numeric,
	"logged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"counts_toward_quota" boolean DEFAULT false NOT NULL,
	"client_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entries_tier_reached_nonnegative" CHECK ("entries"."tier_reached" >= 0),
	CONSTRAINT "entries_numeric_value_finite" CHECK ("entries"."numeric_value" IS NULL OR "entries"."numeric_value" BETWEEN -1000000000 AND 1000000000)
);
--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_habit_id_habits_id_fk" FOREIGN KEY ("habit_id") REFERENCES "public"."habits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_qualifying_entry_per_day" ON "entries" USING btree ("habit_id","local_date") WHERE "entries"."counts_toward_quota";--> statement-breakpoint
CREATE UNIQUE INDEX "entries_client_entry_id_unique" ON "entries" USING btree ("client_entry_id");--> statement-breakpoint
CREATE INDEX "entries_habit_id_local_date_idx" ON "entries" USING btree ("habit_id","local_date" DESC NULLS LAST);