CREATE TABLE "imported_daily_reviews" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"review_date" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imported_task_reviews" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"task_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
