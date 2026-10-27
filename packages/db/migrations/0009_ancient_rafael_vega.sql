-- base_blocks: the §5 strata. One row per completed qualifying run of a tower.
--
-- THERE IS NO caused_collapse COLUMN HERE, AND THERE MUST NEVER BE ONE (§5).
-- Its absence is a product decision, not an omission: a tower's history records
-- what the group built, not who broke it. With no column there is nothing for a
-- future feature, admin screen, export or debug log to casually surface as
-- blame. If you are reading this because you were about to add it: that is the
-- conversation this comment exists to force.
--
-- roster is a FROZEN, deliberately denormalised snapshot, never joined back to
-- users/memberships/habits — which is why it carries display_name, and why
-- 1.2's account-deletion rule must rewrite that name inside the jsonb in place.
-- The ~3-day minimum run length (§5) is evaluator logic (3.9), not a
-- constraint: short runs simply produce no row, and ordinal must stay GAPLESS
-- when one is skipped (it is a position in the stack, not a run counter).
CREATE TABLE "base_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tower_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"run_start_date" date NOT NULL,
	"run_end_date" date NOT NULL,
	"block_height" integer NOT NULL,
	"roster" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "base_blocks_tower_id_ordinal_unique" UNIQUE("tower_id","ordinal"),
	CONSTRAINT "base_blocks_ordinal_positive" CHECK ("base_blocks"."ordinal" >= 1),
	CONSTRAINT "base_blocks_run_end_after_start" CHECK ("base_blocks"."run_end_date" >= "base_blocks"."run_start_date"),
	CONSTRAINT "base_blocks_block_height_positive" CHECK ("base_blocks"."block_height" >= 1),
	CONSTRAINT "base_blocks_block_height_within_run" CHECK ("base_blocks"."block_height" <= ("base_blocks"."run_end_date" - "base_blocks"."run_start_date") + 1),
	CONSTRAINT "base_blocks_roster_nonempty_array" CHECK (jsonb_typeof("base_blocks"."roster") = 'array' AND "base_blocks"."roster" <> '[]'::jsonb)
);
--> statement-breakpoint
ALTER TABLE "base_blocks" ADD CONSTRAINT "base_blocks_tower_id_towers_id_fk" FOREIGN KEY ("tower_id") REFERENCES "public"."towers"("id") ON DELETE cascade ON UPDATE no action;