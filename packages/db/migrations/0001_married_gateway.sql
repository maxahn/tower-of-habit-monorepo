CREATE TYPE "public"."habit_lifecycle" AS ENUM('draft', 'active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."habit_type" AS ENUM('binary', 'numeric', 'tiered');--> statement-breakpoint
CREATE TYPE "public"."period_unit" AS ENUM('day', 'week');--> statement-breakpoint
CREATE TABLE "habits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" varchar(60) NOT NULL,
	"type" "habit_type" NOT NULL,
	"unit" varchar(60),
	"period_unit" "period_unit" DEFAULT 'day' NOT NULL,
	"period_length" integer DEFAULT 1 NOT NULL,
	"quota" integer DEFAULT 1 NOT NULL,
	"lifecycle" "habit_lifecycle" DEFAULT 'draft' NOT NULL,
	"started_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "habits_unit_iff_numeric" CHECK (("habits"."type" = 'numeric') = ("habits"."unit" IS NOT NULL)),
	CONSTRAINT "habits_quota_positive" CHECK ("habits"."quota" >= 1),
	CONSTRAINT "habits_period_length_positive" CHECK ("habits"."period_length" >= 1)
);
--> statement-breakpoint
ALTER TABLE "habits" ADD CONSTRAINT "habits_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "habits_owner_id_idx" ON "habits" USING btree ("owner_id");