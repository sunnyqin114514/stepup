CREATE TABLE "ai_usage" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"usage_date" text NOT NULL,
	"action" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_usage_user_date_action_idx" ON "ai_usage" ("user_id","usage_date","action");