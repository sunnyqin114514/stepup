import {
  boolean,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const goals = pgTable("goals", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  deadline: text("deadline").notNull(),
  dailyMinutes: integer("daily_minutes").notNull().default(60),
  workdays: jsonb("workdays").$type<string[]>().notNull().default([]),
  reviewCycle: text("review_cycle").notNull().default("weekly"),
  status: text("status").notNull().default("active"),
  foundation: text("foundation"),
  weakness: text("weakness"),
  ...timestamps,
});

export const tasks = pgTable("tasks", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  goalId: text("goal_id"),
  date: text("date").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  steps: jsonb("steps").$type<Array<string | { action: string; guide?: string }>>(),
  checkCriteria: text("check_criteria"),
  suggestedMinutes: integer("suggested_minutes").notNull().default(30),
  priority: text("priority").notNull().default("medium"),
  completed: boolean("completed").notNull().default(false),
  focusSeconds: integer("focus_seconds").notNull().default(0),
  source: text("source").notNull().default("goal"),
  subGoal: text("sub_goal"),
  foundation: text("foundation"),
  weakness: text("weakness"),
  topicTags: jsonb("topic_tags").$type<string[]>().notNull().default([]),
  priorityReason: text("priority_reason"),
  resourceSuggestions: jsonb("resource_suggestions").$type<string[]>().notNull().default([]),
  reviewIntervals: jsonb("review_intervals").$type<number[]>().notNull().default([]),
  ...timestamps,
});

export const taskAttempts = pgTable("task_attempts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  taskId: text("task_id").notNull(),
  totalQuestions: integer("total_questions"),
  correctQuestions: integer("correct_questions"),
  wrongText: text("wrong_text"),
  moduleData: jsonb("module_data").$type<Record<string, { total: number; correct: number }>>(),
  lossReasons: jsonb("loss_reasons").$type<string[]>().notNull().default([]),
  focusSeconds: integer("focus_seconds").notNull().default(0),
  ...timestamps,
});

export const resources = pgTable("resources", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  sourceUrl: text("source_url"),
  blobKey: text("blob_key"),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes"),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  extractedText: text("extracted_text").notNull().default(""),
  ...timestamps,
});

export const taskResources = pgTable(
  "task_resources",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    taskId: text("task_id").notNull(),
    resourceId: text("resource_id").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("task_resources_user_task_resource_idx").on(
      table.userId,
      table.taskId,
      table.resourceId,
    ),
  ],
);

export const helpThreads = pgTable("help_threads", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  taskId: text("task_id").notNull(),
  title: text("title").notNull(),
  ...timestamps,
});

export const helpMessages = pgTable("help_messages", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  threadId: text("thread_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  ...timestamps,
});

export const reviewReports = pgTable("review_reports", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  taskId: text("task_id").notNull(),
  goalId: text("goal_id"),
  summary: text("summary").notNull(),
  strengths: jsonb("strengths").$type<string[]>().notNull().default([]),
  weaknesses: jsonb("weaknesses").$type<string[]>().notNull().default([]),
  errorPatterns: jsonb("error_patterns").$type<string[]>().notNull().default([]),
  moduleAccuracy: jsonb("module_accuracy").$type<Record<string, number>>().notNull().default({}),
  lossReasons: jsonb("loss_reasons").$type<string[]>().notNull().default([]),
  focusSeconds: integer("focus_seconds").notNull().default(0),
  accuracy: real("accuracy"),
  ...timestamps,
});

export const reinforcementTasks = pgTable("reinforcement_tasks", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  reportId: text("report_id").notNull(),
  taskId: text("task_id").notNull(),
  title: text("title").notNull(),
  reason: text("reason").notNull(),
  suggestedMinutes: integer("suggested_minutes").notNull().default(15),
  scheduledDate: text("scheduled_date").notNull(),
  completed: boolean("completed").notNull().default(false),
  ...timestamps,
});

export const reviewSchedules = pgTable("review_schedules", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  taskId: text("task_id"),
  resourceId: text("resource_id"),
  title: text("title").notNull(),
  intervals: jsonb("intervals").$type<number[]>().notNull().default([3, 7, 14, 30]),
  intervalIndex: integer("interval_index").notNull().default(0),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  reminderTime: text("reminder_time").notNull().default("20:00"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
});

export const reviewEvents = pgTable("review_events", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  scheduleId: text("schedule_id").notNull(),
  result: text("result").notNull(),
  previousDueAt: timestamp("previous_due_at", { withTimezone: true }).notNull(),
  nextDueAt: timestamp("next_due_at", { withTimezone: true }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }).defaultNow().notNull(),
  ...timestamps,
});

export const importedDailyReviews = pgTable("imported_daily_reviews", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  reviewDate: text("review_date").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  ...timestamps,
});

export const importedTaskReviews = pgTable("imported_task_reviews", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  taskId: text("task_id").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  ...timestamps,
});

export const userEntitlements = pgTable("user_entitlements", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  plan: text("plan").notNull().default("free"),
  proUntil: timestamp("pro_until", { withTimezone: true }),
  migratedAt: timestamp("migrated_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [uniqueIndex("user_entitlements_user_idx").on(table.userId)]);

export const aiUsage = pgTable(
  "ai_usage",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    usageDate: text("usage_date").notNull(),
    action: text("action").notNull(),
    count: integer("count").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("ai_usage_user_date_action_idx").on(
      table.userId,
      table.usageDate,
      table.action,
    ),
  ],
);

export type ResourceRecord = typeof resources.$inferSelect;
export type ReviewScheduleRecord = typeof reviewSchedules.$inferSelect;
