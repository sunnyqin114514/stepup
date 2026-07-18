CREATE TABLE "goals" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"deadline" text NOT NULL,
	"daily_minutes" integer DEFAULT 60 NOT NULL,
	"workdays" jsonb DEFAULT '[]' NOT NULL,
	"review_cycle" text DEFAULT 'weekly' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"foundation" text,
	"weakness" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "help_messages" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "help_threads" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"task_id" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reinforcement_tasks" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"report_id" text NOT NULL,
	"task_id" text NOT NULL,
	"title" text NOT NULL,
	"reason" text NOT NULL,
	"suggested_minutes" integer DEFAULT 15 NOT NULL,
	"scheduled_date" text NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"source_url" text,
	"blob_key" text,
	"mime_type" text,
	"size_bytes" integer,
	"tags" jsonb DEFAULT '[]' NOT NULL,
	"extracted_text" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_events" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"schedule_id" text NOT NULL,
	"result" text NOT NULL,
	"previous_due_at" timestamp with time zone NOT NULL,
	"next_due_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_reports" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"task_id" text NOT NULL,
	"goal_id" text,
	"summary" text NOT NULL,
	"strengths" jsonb DEFAULT '[]' NOT NULL,
	"weaknesses" jsonb DEFAULT '[]' NOT NULL,
	"error_patterns" jsonb DEFAULT '[]' NOT NULL,
	"module_accuracy" jsonb DEFAULT '{}' NOT NULL,
	"loss_reasons" jsonb DEFAULT '[]' NOT NULL,
	"focus_seconds" integer DEFAULT 0 NOT NULL,
	"accuracy" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_schedules" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"task_id" text,
	"resource_id" text,
	"title" text NOT NULL,
	"intervals" jsonb DEFAULT '[3,7,14,30]' NOT NULL,
	"interval_index" integer DEFAULT 0 NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"reminder_time" text DEFAULT '20:00' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_attempts" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"task_id" text NOT NULL,
	"total_questions" integer,
	"correct_questions" integer,
	"wrong_text" text,
	"module_data" jsonb,
	"loss_reasons" jsonb DEFAULT '[]' NOT NULL,
	"focus_seconds" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_resources" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"task_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"goal_id" text,
	"date" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"steps" jsonb,
	"check_criteria" text,
	"suggested_minutes" integer DEFAULT 30 NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"focus_seconds" integer DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'goal' NOT NULL,
	"sub_goal" text,
	"foundation" text,
	"weakness" text,
	"topic_tags" jsonb DEFAULT '[]' NOT NULL,
	"priority_reason" text,
	"resource_suggestions" jsonb DEFAULT '[]' NOT NULL,
	"review_intervals" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_entitlements" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"pro_until" timestamp with time zone,
	"migrated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "task_resources_user_task_resource_idx" ON "task_resources" ("user_id","task_id","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_entitlements_user_idx" ON "user_entitlements" ("user_id");