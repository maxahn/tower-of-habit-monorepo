-- Hand-edited: drizzle-kit 0.31 emits "undefined"."citext" for custom types in
-- ALTER COLUMN. Snapshot is correct; only this SQL needed the fix.
ALTER TABLE "users" ALTER COLUMN "email" SET DATA TYPE citext;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_length" CHECK (length("users"."email") <= 320);