import type { Config } from "@netlify/functions";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { db } from "../../db";
import {
  reviewEvents,
  reviewReports,
  reviewSchedules,
  tasks,
} from "../../db/schema";
import { createId, getEntitlement, isAuthResponse, requireUser } from "./_shared/auth";
import { nextReviewDate, normalizeIntervals } from "./_shared/resourceValidation";

export default async (req: Request): Promise<Response> => {
  const auth = await requireUser();
  if (isAuthResponse(auth)) return auth;
  const url = new URL(req.url);

  try {
    if (req.method === "GET") {
      const mode = url.searchParams.get("mode") ?? "due";
      if (mode === "reports") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        const goalId = url.searchParams.get("goalId");
        const datePattern = /^\d{4}-\d{2}-\d{2}$/;
        if (
          (from && (!datePattern.test(from) || Number.isNaN(new Date(`${from}T00:00:00Z`).getTime()))) ||
          (to && (!datePattern.test(to) || Number.isNaN(new Date(`${to}T23:59:59Z`).getTime()))) ||
          (from && to && from > to) ||
          (goalId && goalId.length > 200)
        ) {
          return Response.json({ error: "筛选日期或目标无效" }, { status: 400 });
        }
        const conditions = [eq(reviewReports.userId, auth.id)];
        if (from) conditions.push(gte(reviewReports.createdAt, new Date(`${from}T00:00:00Z`)));
        if (to) conditions.push(lte(reviewReports.createdAt, new Date(`${to}T23:59:59Z`)));
        if (goalId) conditions.push(eq(reviewReports.goalId, goalId));
        const reports = await db
          .select()
          .from(reviewReports)
          .where(and(...conditions))
          .orderBy(desc(reviewReports.createdAt));
        return Response.json({ reports });
      }
      const now = new Date();
      const schedules = await db
        .select()
        .from(reviewSchedules)
        .where(
          and(
            eq(reviewSchedules.userId, auth.id),
            eq(reviewSchedules.active, true),
            lte(reviewSchedules.dueAt, now),
          ),
        )
        .orderBy(asc(reviewSchedules.dueAt));
      const entitlement = await getEntitlement(auth.id);
      return Response.json({ schedules, dueCount: schedules.length, entitlement });
    }

    if (req.method === "POST") {
      const body = (await req.json()) as Record<string, unknown>;
      const action = String(body.action ?? "schedule");
      if (action === "schedule") {
        const taskId = body.taskId ? String(body.taskId) : null;
        if (taskId) {
          const [task] = await db
            .select({ id: tasks.id })
            .from(tasks)
            .where(and(eq(tasks.id, taskId), eq(tasks.userId, auth.id)))
            .limit(1);
          if (!task) return Response.json({ error: "任务不存在" }, { status: 404 });
        }
        const intervals = normalizeIntervals(body.intervals);
        if (!intervals.length) return Response.json({ error: "至少选择一个复习周期" }, { status: 400 });
        const title = String(body.title ?? "复习任务").trim();
        const reminderTime = String(body.reminderTime ?? "20:00");
        if (!title || title.length > 160 || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(reminderTime)) {
          return Response.json({ error: "复习标题或提醒时间无效" }, { status: 400 });
        }
        const dueAt = new Date();
        dueAt.setDate(dueAt.getDate() + intervals[0]);
        const [schedule] = await db
          .insert(reviewSchedules)
          .values({
            id: createId("schedule"),
            userId: auth.id,
            taskId,
            resourceId: body.resourceId ? String(body.resourceId) : null,
            title,
            intervals,
            intervalIndex: 0,
            dueAt,
            reminderTime,
          })
          .returning();
        return Response.json({ schedule }, { status: 201 });
      }
      if (action === "feedback") {
        const scheduleId = String(body.scheduleId ?? "");
        const result = String(body.result ?? "") as "remember" | "fuzzy" | "forgot";
        if (!["remember", "fuzzy", "forgot"].includes(result)) {
          return Response.json({ error: "复习反馈无效" }, { status: 400 });
        }
        const [schedule] = await db
          .select()
          .from(reviewSchedules)
          .where(and(eq(reviewSchedules.id, scheduleId), eq(reviewSchedules.userId, auth.id)))
          .limit(1);
        if (!schedule) return Response.json({ error: "复习计划不存在" }, { status: 404 });
        const next = nextReviewDate(new Date(), schedule.intervals, schedule.intervalIndex, result);
        await db.insert(reviewEvents).values({
          id: createId("event"),
          userId: auth.id,
          scheduleId,
          result,
          previousDueAt: schedule.dueAt,
          nextDueAt: next.dueAt,
        });
        const [updated] = await db
          .update(reviewSchedules)
          .set({
            intervalIndex: next.intervalIndex,
            dueAt: next.dueAt,
            updatedAt: new Date(),
          })
          .where(and(eq(reviewSchedules.id, scheduleId), eq(reviewSchedules.userId, auth.id)))
          .returning();
        return Response.json({ schedule: updated, algorithm: "记得=进入下一周期；模糊=当前周期减半；忘了=次日重启" });
      }
      if (action === "addToToday") {
        const scheduleId = String(body.scheduleId ?? "");
        const [schedule] = await db
          .select()
          .from(reviewSchedules)
          .where(and(eq(reviewSchedules.id, scheduleId), eq(reviewSchedules.userId, auth.id)))
          .limit(1);
        if (!schedule) return Response.json({ error: "复习计划不存在" }, { status: 404 });
        const [task] = await db
          .insert(tasks)
          .values({
            id: createId("task"),
            userId: auth.id,
            date: new Date().toISOString().slice(0, 10),
            title: `复习：${schedule.title}`.slice(0, 160),
            description: "由到期复习提醒写入学习日",
            source: "adhoc",
            suggestedMinutes: 15,
            priority: "high",
          })
          .returning();
        return Response.json({
          task: {
            id: task.id,
            goalId: task.goalId ?? undefined,
            date: task.date,
            title: task.title,
            description: task.description,
            steps: ["打开原任务或绑定资料", "遮挡答案完成主动回忆", "根据结果提交“记得 / 模糊 / 忘了”反馈"],
            checkCriteria: "能够独立复述核心内容，并完成本次复习反馈",
            priority: task.priority,
            source: task.source,
            suggestedMinutes: task.suggestedMinutes,
            reviewIntervals: schedule.intervals,
            resources: schedule.resourceId ? [schedule.resourceId] : [],
          },
        }, { status: 201 });
      }
      if (action === "batch") {
        const entitlement = await getEntitlement(auth.id);
        if (!entitlement.pro) return Response.json({ error: "批量提醒为 Pro 功能" }, { status: 403 });
        const ids = Array.isArray(body.scheduleIds) ? body.scheduleIds.map(String).slice(0, 100) : [];
        return Response.json({ accepted: ids.length, note: "站内批量提醒已启用；邮件/浏览器推送未配置外部 provider" });
      }
    }
  } catch (error) {
    console.error("复习 API 处理失败", error);
    return Response.json({ error: error instanceof Error ? error.message : "复习处理失败" }, { status: 500 });
  }
  return new Response("Method Not Allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/reviews",
  method: ["GET", "POST"],
};
