import type { Config } from "@netlify/functions";
import type { TaskReviewRequest, TaskReviewResponse } from "../../src/types/plan";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import {
  reinforcementTasks,
  reviewReports,
  reviewSchedules,
  taskAttempts,
  tasks,
} from "../../db/schema";
import { checkOrigin, createAiClient } from "./_shared/aiClient";
import { createId, getEntitlement, isAuthResponse, requireUser } from "./_shared/auth";
import { normalizeIntervals } from "./_shared/resourceValidation";

type ReviewJson = Pick<
  TaskReviewResponse,
  "summary" | "strengths" | "weaknesses" | "errorPatterns" | "moduleAccuracy" | "lossReasons"
> & {
  reinforcementTasks: Array<{ title: string; reason: string; suggestedMinutes: number }>;
};

function fallbackReview(body: TaskReviewRequest): ReviewJson {
  const total = Number(body.attempt.totalQuestions) || 0;
  const correct = Number(body.attempt.correctQuestions) || 0;
  const accuracy = total > 0 ? Math.round((correct / total) * 100) : null;
  const lossReasons = (body.attempt.lossReasons ?? []).map(String).filter(Boolean);
  return {
    summary: `${body.task.title}已完成${accuracy === null ? "" : `，正确率 ${accuracy}%`}。`,
    strengths: ["完成任务并留下了可追踪的执行记录"],
    weaknesses: lossReasons.length ? lossReasons : ["需要补充更具体的错题与模块数据"],
    errorPatterns: body.attempt.wrongText?.trim() ? ["错题文本中记录的知识或步骤偏差"] : [],
    moduleAccuracy: Object.fromEntries(
      Object.entries(body.attempt.moduleData ?? {}).map(([name, data]) => [
        name,
        Number(data.total) > 0 ? Math.round((Number(data.correct) / Number(data.total)) * 100) : 0,
      ]),
    ),
    lossReasons,
    reinforcementTasks: [
      {
        title: `补强：${body.task.title}`,
        reason: lossReasons[0] ?? "复查错题并用自检标准重新验收",
        suggestedMinutes: 15,
      },
    ],
  };
}

function sanitizeReview(raw: unknown, fallback: ReviewJson): ReviewJson {
  if (!raw || typeof raw !== "object") return fallback;
  const value = raw as Record<string, unknown>;
  const strings = (input: unknown, defaults: string[]) =>
    Array.isArray(input)
      ? input.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 12)
      : defaults;
  const moduleAccuracy: Record<string, number> = {};
  if (value.moduleAccuracy && typeof value.moduleAccuracy === "object") {
    for (const [name, score] of Object.entries(value.moduleAccuracy as Record<string, unknown>)) {
      moduleAccuracy[name.slice(0, 80)] = Math.max(0, Math.min(100, Number(score) || 0));
    }
  }
  const reinforcement = Array.isArray(value.reinforcementTasks)
    ? value.reinforcementTasks
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const task = item as Record<string, unknown>;
          const title = String(task.title ?? "").trim();
          if (!title) return null;
          return {
            title: title.slice(0, 160),
            reason: String(task.reason ?? "针对薄弱点补强").slice(0, 300),
            suggestedMinutes: Math.max(5, Math.min(180, Number(task.suggestedMinutes) || 15)),
          };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .slice(0, 6)
    : fallback.reinforcementTasks;
  return {
    summary: String(value.summary ?? fallback.summary).slice(0, 500),
    strengths: strings(value.strengths, fallback.strengths),
    weaknesses: strings(value.weaknesses, fallback.weaknesses),
    errorPatterns: strings(value.errorPatterns, fallback.errorPatterns),
    moduleAccuracy:
      Object.keys(moduleAccuracy).length > 0 ? moduleAccuracy : fallback.moduleAccuracy,
    lossReasons: strings(value.lossReasons, fallback.lossReasons),
    reinforcementTasks: reinforcement.length ? reinforcement : fallback.reinforcementTasks,
  };
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (!checkOrigin(req)) return new Response("Forbidden", { status: 403 });
  const auth = await requireUser();
  if (isAuthResponse(auth)) return auth;

  let body: TaskReviewRequest;
  try {
    body = (await req.json()) as TaskReviewRequest;
  } catch (error) {
    console.error("复盘请求 JSON 解析失败", error);
    return Response.json({ error: "无效的请求体" }, { status: 400 });
  }
  if (!body.task?.id || !body.task.title?.trim()) {
    return Response.json({ error: "缺少任务信息" }, { status: 400 });
  }
  const total = Math.max(0, Number(body.attempt?.totalQuestions) || 0);
  const correct = Math.max(0, Number(body.attempt?.correctQuestions) || 0);
  if (total > 0 && correct > total) {
    return Response.json({ error: "正确数不能大于总题数" }, { status: 400 });
  }
  if (total === 0 && !String(body.attempt?.wrongText ?? "").trim()) {
    return Response.json({ error: "请填写题目统计或错题记录后再复盘" }, { status: 400 });
  }
  const moduleData = body.attempt?.moduleData ?? {};
  for (const [name, data] of Object.entries(moduleData)) {
    const moduleTotal = Number(data?.total);
    const moduleCorrect = Number(data?.correct);
    if (
      !name.trim() ||
      !Number.isFinite(moduleTotal) ||
      !Number.isFinite(moduleCorrect) ||
      moduleTotal < 0 ||
      moduleCorrect < 0 ||
      moduleCorrect > moduleTotal
    ) {
      return Response.json({ error: "模块统计数据无效" }, { status: 400 });
    }
  }
  try {
    const [ownedTask] = await db
      .select({ id: tasks.id, goalId: tasks.goalId })
      .from(tasks)
      .where(and(eq(tasks.id, body.task.id), eq(tasks.userId, auth.id)))
      .limit(1);
    if (!ownedTask) return Response.json({ error: "任务不存在或不属于当前用户" }, { status: 404 });
    if (body.goalId && ownedTask.goalId !== body.goalId) {
      return Response.json({ error: "任务与目标不匹配" }, { status: 400 });
    }
  } catch (error) {
    console.error("复盘任务归属校验失败", error);
    return Response.json({ error: "任务校验失败，请重试" }, { status: 500 });
  }
  const focusSeconds = Math.max(0, Number(body.focusSeconds) || Number(body.task.focusSeconds) || 0);
  const reminderTime = String(body.reminderTime ?? "20:00");
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(reminderTime)) {
    return Response.json({ error: "提醒时间无效" }, { status: 400 });
  }
  const fallback = fallbackReview({ ...body, focusSeconds });
  const prompt = `你是通用学习复盘教练。只输出 JSON，不限定任何考试或学科。
任务：${body.task.title}
说明：${body.task.description || "无"}
目标：${body.goalTitle || "临时任务"}
自检：${body.task.checkCriteria || "无"}
专注秒数：${focusSeconds}
总题数：${total || "未填"}；正确数：${total ? correct : "未填"}
错题记录：${String(body.attempt.wrongText ?? "无").slice(0, 4000)}
模块数据：${JSON.stringify(body.attempt.moduleData ?? {})}
失分原因：${JSON.stringify(body.attempt.lossReasons ?? [])}
输出字段：summary 字符串；strengths/weaknesses/errorPatterns/lossReasons 字符串数组；
moduleAccuracy 为模块名到 0-100 正确率；reinforcementTasks 为 1-4 条 {title,reason,suggestedMinutes}。
补强任务必须具体、可在 5-60 分钟完成。`;

  let review = fallback;
  let mock = false;
  try {
    const ai = createAiClient();
    if (!ai) {
      throw new Error("AI client unavailable: missing DeepSeek key and Netlify AI Gateway key");
    }
    const { client, model } = ai;
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "你是结构化复盘教练，只输出合法 JSON。" },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 1200,
      response_format: { type: "json_object" },
    });
    const content = completion.choices?.[0]?.message?.content ?? "";
    review = sanitizeReview(JSON.parse(content), fallback);
  } catch (error) {
    console.error("AI 结构化复盘失败，使用确定性降级结果", error);
    mock = true;
  }

  try {
    const entitlement = await getEntitlement(auth.id);
    if (!entitlement.pro) {
      review = { ...review, reinforcementTasks: review.reinforcementTasks.slice(0, 1) };
    }
    const attemptId = createId("attempt");
    await db.insert(taskAttempts).values({
      id: attemptId,
      userId: auth.id,
      taskId: body.task.id,
      totalQuestions: total || null,
      correctQuestions: total ? correct : null,
      wrongText: String(body.attempt.wrongText ?? "").slice(0, 20_000) || null,
      moduleData: body.attempt.moduleData ?? null,
      lossReasons: body.attempt.lossReasons ?? [],
      focusSeconds,
    });
    const reportId = createId("report");
    const accuracy = total > 0 ? correct / total : null;
    await db.insert(reviewReports).values({
      id: reportId,
      userId: auth.id,
      taskId: body.task.id,
      goalId: body.goalId ?? null,
      summary: review.summary,
      strengths: review.strengths,
      weaknesses: review.weaknesses,
      errorPatterns: review.errorPatterns,
      moduleAccuracy: review.moduleAccuracy,
      lossReasons: review.lossReasons,
      focusSeconds,
      accuracy,
    });

    const date = new Date();
    date.setDate(date.getDate() + 1);
    const createdReinforcement = [];
    for (const item of review.reinforcementTasks) {
      const id = createId("reinforcement");
      const taskId = createId("task");
      const scheduledDate = date.toISOString().slice(0, 10);
      await db.insert(reinforcementTasks).values({
        id,
        userId: auth.id,
        reportId,
        taskId,
        title: item.title,
        reason: item.reason,
        suggestedMinutes: item.suggestedMinutes,
        scheduledDate,
      });
      await db.insert(tasks).values({
        id: taskId,
        userId: auth.id,
        goalId: body.goalId ?? null,
        date: scheduledDate,
        title: item.title,
        description: item.reason,
        source: body.goalId ? "goal" : "adhoc",
        priority: "high",
        suggestedMinutes: item.suggestedMinutes,
        topicTags: body.task.topicTags ?? [],
        priorityReason: "AI 复盘识别出的薄弱点补强",
      });
      createdReinforcement.push({ id, taskId, ...item, scheduledDate });
    }

    const intervals = normalizeIntervals(body.reviewIntervals);
    const scheduleIds: string[] = [];
    if (intervals.length > 0) {
      const dueAt = new Date();
      dueAt.setDate(dueAt.getDate() + intervals[0]);
      const scheduleId = createId("schedule");
      await db.insert(reviewSchedules).values({
        id: scheduleId,
        userId: auth.id,
        taskId: body.task.id,
        title: body.task.title,
        intervals,
        intervalIndex: 0,
        dueAt,
        reminderTime,
      });
      scheduleIds.push(scheduleId);
    }
    const report = [
      review.summary,
      `做得好：${review.strengths.join("；") || "已完成并记录"}`,
      `薄弱点：${review.weaknesses.join("；") || "暂无"}`,
      `失分原因：${review.lossReasons.join("；") || "暂无"}`,
    ].join("\n");
    const response: TaskReviewResponse = {
      report,
      reportId,
      ...review,
      reinforcementTasks: createdReinforcement,
      scheduleIds,
      mock,
    };
    return Response.json(response);
  } catch (error) {
    console.error("复盘持久化失败，不返回未落库的报告", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "复盘保存失败，请重试" },
      { status: 500 },
    );
  }
};

export const config: Config = {
  path: "/api/task-review",
  method: "POST",
};
