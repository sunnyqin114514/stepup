import type { Config } from "@netlify/functions";
import { and, eq, notInArray } from "drizzle-orm";
import { db } from "../../db";
import {
  goals,
  importedDailyReviews,
  importedTaskReviews,
  taskResources,
  tasks,
  userEntitlements,
} from "../../db/schema";
import { createId, getRequestEntitlement, isAuthResponse, requireUser } from "./_shared/auth";

type ImportedTask = {
  id?: string;
  date?: string;
  title?: string;
  description?: string;
  steps?: unknown;
  checkCriteria?: string;
  suggestedMinutes?: number;
  priority?: string;
  completed?: boolean;
  focusSeconds?: number;
  source?: string;
  goalId?: string;
  subGoal?: string;
  topicTags?: string[];
  priorityReason?: string;
  resourceSuggestions?: string[];
  reviewIntervals?: number[];
};

export default async (req: Request): Promise<Response> => {
  const auth = await requireUser();
  if (isAuthResponse(auth)) return auth;
  try {
    if (req.method === "GET") {
      const entitlement = await getRequestEntitlement(auth.id, req);
      const [record] = await db
        .select({ migratedAt: userEntitlements.migratedAt })
        .from(userEntitlements)
        .where(eq(userEntitlements.userId, auth.id))
        .limit(1);
      const goalRows = await db
        .select()
        .from(goals)
        .where(eq(goals.userId, auth.id));
      const taskRows = await db
        .select()
        .from(tasks)
        .where(eq(tasks.userId, auth.id));
      const plans = goalRows.map((goal) => ({
        id: goal.id,
        goal: goal.title,
        deadline: goal.deadline,
        dailyMinutes: goal.dailyMinutes,
        workdays: goal.workdays,
        reviewCycle: goal.reviewCycle,
        createdAt: goal.createdAt.toISOString(),
        status: goal.status,
        foundation: goal.foundation ?? undefined,
        weakness: goal.weakness ?? undefined,
        tasks: taskRows
          .filter((task) => task.goalId === goal.id)
          .map(toClientTask),
      }));
      const workspace = {
        plans,
        activePlanId:
          plans.find((plan) => plan.status === "active")?.id ??
          plans[0]?.id ??
          null,
        adhocTasks: taskRows
          .filter((task) => !task.goalId)
          .map(toClientTask),
      };
      return Response.json({
        entitlement,
        migrated: Boolean(record?.migratedAt),
        workspace,
      });
    }
    if (req.method === "POST") {
      const body = (await req.json()) as Record<string, unknown>;
      const action = String(body.action ?? "migrate");
      if (action === "setDevPro") {
        if (!auth.development) {
          return Response.json({ error: "仅本地开发可模拟 Pro 权益" }, { status: 403 });
        }
        const pro = Boolean(body.pro);
        const now = new Date();
        const proUntil = pro ? new Date(now.getTime() + 7 * 86_400_000) : null;
        const [existing] = await db
          .select()
          .from(userEntitlements)
          .where(eq(userEntitlements.userId, auth.id))
          .limit(1);
        if (existing) {
          await db
            .update(userEntitlements)
            .set({
              plan: pro ? "pro" : "free",
              proUntil,
              updatedAt: now,
            })
            .where(and(eq(userEntitlements.id, existing.id), eq(userEntitlements.userId, auth.id)));
        } else {
          await db.insert(userEntitlements).values({
            id: createId("entitlement"),
            userId: auth.id,
            plan: pro ? "pro" : "free",
            proUntil,
          });
        }
        return Response.json({
          entitlement: { plan: pro ? "pro" : "free", pro },
        });
      }
      if (action !== "migrate" && action !== "sync") {
        return Response.json({ error: "工作区操作无效" }, { status: 400 });
      }
      const workspace = body.workspace as
        | {
            plans?: Array<Record<string, unknown> & { tasks?: ImportedTask[] }>;
            adhocTasks?: ImportedTask[];
          }
        | undefined;
      if (!workspace || !Array.isArray(workspace.plans)) {
        return Response.json({ error: "迁移数据格式无效" }, { status: 400 });
      }
      const [existingEntitlement] = await db
        .select()
        .from(userEntitlements)
        .where(eq(userEntitlements.userId, auth.id))
        .limit(1);
      if (existingEntitlement?.migratedAt && action !== "sync") {
        return Response.json({ migrated: true, alreadyMigrated: true });
      }

      const entitlement = await getRequestEntitlement(auth.id, req);
      let importedGoals = 0;
      let importedTasks = 0;
      let activeGoals = 0;
      for (const plan of workspace.plans.slice(0, 50)) {
        const goalId = String(plan.id ?? createId("goal"));
        const title = String(plan.goal ?? "").trim();
        if (!title) continue;
        const requestedStatus = String(plan.status ?? "active");
        const status =
          !entitlement.pro && requestedStatus === "active" && activeGoals >= 1
            ? "paused"
            : requestedStatus;
        if (status === "active") activeGoals += 1;
        await db
          .insert(goals)
          .values({
            id: goalId,
            userId: auth.id,
            title,
            deadline: String(plan.deadline ?? new Date().toISOString().slice(0, 10)),
            dailyMinutes: Number(plan.dailyMinutes) || 60,
            workdays: Array.isArray(plan.workdays) ? plan.workdays.map(String) : ["weekday", "weekend"],
            reviewCycle: String(plan.reviewCycle ?? "weekly"),
            status,
            foundation: plan.foundation ? String(plan.foundation) : null,
            weakness: plan.weakness ? String(plan.weakness) : null,
          })
          .onConflictDoNothing();
        await db
          .update(goals)
          .set({
            title,
            deadline: String(plan.deadline ?? new Date().toISOString().slice(0, 10)),
            dailyMinutes: Number(plan.dailyMinutes) || 60,
            workdays: Array.isArray(plan.workdays) ? plan.workdays.map(String) : ["weekday", "weekend"],
            reviewCycle: String(plan.reviewCycle ?? "weekly"),
            status,
            foundation: plan.foundation ? String(plan.foundation) : null,
            weakness: plan.weakness ? String(plan.weakness) : null,
            updatedAt: new Date(),
          })
          .where(and(eq(goals.id, goalId), eq(goals.userId, auth.id)));
        importedGoals += 1;
        for (const task of (plan.tasks ?? []).slice(0, 1000)) {
          importedTasks += await importTask(task, auth.id, goalId);
        }
      }
      for (const task of (workspace.adhocTasks ?? []).slice(0, 1000)) {
        importedTasks += await importTask(task, auth.id, null);
      }
      if (action === "sync") {
        const goalIds = workspace.plans
          .map((plan) => String(plan.id ?? ""))
          .filter(Boolean);
        const taskIds = [
          ...workspace.plans.flatMap((plan) =>
            (plan.tasks ?? []).map((task) => String(task.id ?? "")).filter(Boolean),
          ),
          ...(workspace.adhocTasks ?? [])
            .map((task) => String(task.id ?? ""))
            .filter(Boolean),
        ];
        const staleTasks = await db
          .select({ id: tasks.id })
          .from(tasks)
          .where(
            taskIds.length
              ? and(eq(tasks.userId, auth.id), notInArray(tasks.id, taskIds))
              : eq(tasks.userId, auth.id),
          );
        for (const stale of staleTasks) {
          await db
            .delete(taskResources)
            .where(
              and(
                eq(taskResources.userId, auth.id),
                eq(taskResources.taskId, stale.id),
              ),
            );
        }
        await db
          .delete(tasks)
          .where(
            taskIds.length
              ? and(eq(tasks.userId, auth.id), notInArray(tasks.id, taskIds))
              : eq(tasks.userId, auth.id),
          );
        await db
          .delete(goals)
          .where(
            goalIds.length
              ? and(eq(goals.userId, auth.id), notInArray(goals.id, goalIds))
              : eq(goals.userId, auth.id),
          );
      }
      let importedReviews = 0;
      if (action === "migrate") {
        const reviews = Array.isArray(body.reviews) ? body.reviews : [];
        for (const value of reviews.slice(0, 2_000)) {
          if (!value || typeof value !== "object") continue;
          const review = value as Record<string, unknown>;
          const id = String(review.id ?? createId("daily-review"));
          const reviewDate = String(review.date ?? "");
          if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewDate)) continue;
          await db
            .insert(importedDailyReviews)
            .values({ id, userId: auth.id, reviewDate, payload: review })
            .onConflictDoNothing();
          await db
            .update(importedDailyReviews)
            .set({ reviewDate, payload: review, updatedAt: new Date() })
            .where(and(eq(importedDailyReviews.id, id), eq(importedDailyReviews.userId, auth.id)));
          importedReviews += 1;
        }
        const taskReviews = Array.isArray(body.taskAiReviews) ? body.taskAiReviews : [];
        for (const value of taskReviews.slice(0, 2_000)) {
          if (!value || typeof value !== "object") continue;
          const review = value as Record<string, unknown>;
          const id = String(review.id ?? createId("task-review"));
          const taskId = String(review.taskId ?? "");
          if (!taskId) continue;
          await db
            .insert(importedTaskReviews)
            .values({ id, userId: auth.id, taskId, payload: review })
            .onConflictDoNothing();
          await db
            .update(importedTaskReviews)
            .set({ taskId, payload: review, updatedAt: new Date() })
            .where(and(eq(importedTaskReviews.id, id), eq(importedTaskReviews.userId, auth.id)));
          importedReviews += 1;
        }
      }
      const migratedAt = existingEntitlement?.migratedAt ?? new Date();
      if (existingEntitlement) {
        await db
          .update(userEntitlements)
          .set({ migratedAt, updatedAt: migratedAt })
          .where(and(eq(userEntitlements.id, existingEntitlement.id), eq(userEntitlements.userId, auth.id)));
      } else {
        await db.insert(userEntitlements).values({
          id: createId("entitlement"),
          userId: auth.id,
          plan: "free",
          migratedAt,
        });
      }
      return Response.json({
        migrated: true,
        synced: action === "sync",
        importedGoals,
        importedTasks,
        importedReviews,
      });
    }
  } catch (error) {
    console.error("工作区迁移失败，可安全重试", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "迁移失败，本地数据未删除，可重试" },
      { status: 500 },
    );
  }
  return new Response("Method Not Allowed", { status: 405 });
};

async function importTask(task: ImportedTask, userId: string, goalId: string | null): Promise<number> {
  const title = String(task.title ?? "").trim();
  if (!title) return 0;
  const taskId = String(task.id ?? createId("task"));
  await db
    .insert(tasks)
    .values({
      id: taskId,
      userId,
      goalId,
      date: String(task.date ?? new Date().toISOString().slice(0, 10)),
      title,
      description: String(task.description ?? ""),
      steps: Array.isArray(task.steps) ? (task.steps as Array<string | { action: string; guide?: string }>) : null,
      checkCriteria: task.checkCriteria ?? null,
      suggestedMinutes: Number(task.suggestedMinutes) || 30,
      priority: ["high", "medium", "low"].includes(String(task.priority)) ? String(task.priority) : "medium",
      completed: Boolean(task.completed),
      focusSeconds: Number(task.focusSeconds) || 0,
      source: String(task.source ?? (goalId ? "goal" : "adhoc")),
      subGoal: task.subGoal ?? null,
      topicTags: Array.isArray(task.topicTags) ? task.topicTags.map(String) : [],
      priorityReason: task.priorityReason ?? null,
      resourceSuggestions: Array.isArray(task.resourceSuggestions) ? task.resourceSuggestions.map(String) : [],
      reviewIntervals: Array.isArray(task.reviewIntervals) ? task.reviewIntervals.map(Number) : [],
    })
    .onConflictDoNothing();
  await db
    .update(tasks)
    .set({
      goalId,
      date: String(task.date ?? new Date().toISOString().slice(0, 10)),
      title,
      description: String(task.description ?? ""),
      steps: Array.isArray(task.steps) ? (task.steps as Array<string | { action: string; guide?: string }>) : null,
      checkCriteria: task.checkCriteria ?? null,
      suggestedMinutes: Number(task.suggestedMinutes) || 30,
      priority: ["high", "medium", "low"].includes(String(task.priority)) ? String(task.priority) : "medium",
      completed: Boolean(task.completed),
      focusSeconds: Number(task.focusSeconds) || 0,
      source: String(task.source ?? (goalId ? "goal" : "adhoc")),
      subGoal: task.subGoal ?? null,
      topicTags: Array.isArray(task.topicTags) ? task.topicTags.map(String) : [],
      priorityReason: task.priorityReason ?? null,
      resourceSuggestions: Array.isArray(task.resourceSuggestions) ? task.resourceSuggestions.map(String) : [],
      reviewIntervals: Array.isArray(task.reviewIntervals) ? task.reviewIntervals.map(Number) : [],
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)));
  return 1;
}

function toClientTask(task: typeof tasks.$inferSelect) {
  return {
    id: task.id,
    date: task.date,
    title: task.title,
    description: task.description,
    steps: task.steps ?? undefined,
    checkCriteria: task.checkCriteria ?? undefined,
    suggestedMinutes: task.suggestedMinutes,
    priority: task.priority,
    completed: task.completed,
    focusSeconds: task.focusSeconds,
    source: task.source,
    goalId: task.goalId ?? undefined,
    subGoal: task.subGoal ?? undefined,
    foundation: task.foundation ?? undefined,
    weakness: task.weakness ?? undefined,
    topicTags: task.topicTags,
    priorityReason: task.priorityReason ?? undefined,
    resourceSuggestions: task.resourceSuggestions,
    reviewIntervals: task.reviewIntervals,
  };
}

export const config: Config = {
  path: "/api/workspace",
  method: ["GET", "POST"],
};
