CREATE TABLE "email_deliverability" (
	"email" "citext" PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL
);
