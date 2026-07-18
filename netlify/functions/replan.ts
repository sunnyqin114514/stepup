import type { Config } from "@netlify/functions";
import type {
  PlanSchedule,
  ReplanRequest,
  ReplanResponse,
  TaskItem,
  Priority,
} from "../../src/types/plan";
import {
  buildDefaultSchedule,
  distributeTasksToWorkDates,
  listExecutableDays,
  localDateStr,
  snapToNextExecutableDay,
} from "../../src/lib/scheduleDates";
import { compactPlainText, stripMarkdown } from "../../src/lib/textSanitize";
import { checkOrigin, createAiClient } from "./_shared/aiClient";
import { consumeAiQuota, isAuthResponse, isTesterModeRequest, requireUser } from "./_shared/auth";

function resolveBudget(req: ReplanRequest): number {
  const allocated = Number(req.allocatedDailyMinutes);
  if (Number.isFinite(allocated) && allocated >= 15) return Math.round(allocated);
  return Math.max(15, Math.round(Number(req.tomorrowMinutes) || 120));
}

function buildPrompt(req: ReplanRequest): string {
  const unfinished = req.plan.tasks.filter((t) => !t.completed);
  const today = localDateStr();
  const budget = resolveBudget(req);
  const workdays = req.plan.workdays?.length
    ? req.plan.workdays
    : ["weekday", "weekend"];
  const schedule = buildDefaultSchedule(today, req.plan.deadline, workdays);
  const executable = listExecutableDays(today, req.plan.deadline, workdays);

  return `你是计划重排助手。根据用户反馈动态调整剩余任务与休息日。只输出合法 JSON，禁止 Markdown。

【目标】${req.plan.goal}
【截止日期】${req.plan.deadline}
【今日困难/调整说明】${req.difficulty || "无"}
【本目标每日预算】${budget} 分钟
【全局每日上限】${Number(req.globalDailyCap) || budget} 分钟
【其他目标今日已占用】${Number(req.otherGoalsOccupiedMinutes) || 0} 分钟
【本目标完成率】${Number.isFinite(Number(req.goalCompletionRate)) ? `${req.goalCompletionRate}%` : "暂无"}
【可执行日偏好】${workdays.join("、")}，共 ${executable.length} 天
【推荐工作日样例】${schedule.workDates.slice(0, 8).join("、")}
【推荐休息日样例】${schedule.restDates.slice(0, 6).join("、") || "无"}

【未完成任务】
${unfinished
  .map(
    (t) =>
      `- ${t.date} | ${t.title} | 建议${t.suggestedMinutes}分钟 | 优先级${t.priority}${
        t.checkCriteria ? ` | 自检:${stripMarkdown(t.checkCriteria)}` : ""
      }`,
  )
  .join("\n") || "（无）"}

规则：
1. 只重排未完成任务；不要输出已完成任务。
2. 任务只能落在工作日；每天总分钟 ≤ ${Math.round(budget * 0.9)}。
3. 根据困难动态调整：太累则增加休息日/降低每日量；状态好可略增强度。
4. 高优先级靠前；日期覆盖到截止前冲刺周。
5. 输出 schedule.workDates 与 schedule.restDates。
6. 保留 checkCriteria；纯文本，禁止 **。

输出：
{"schedule":{"workDates":["YYYY-MM-DD"],"restDates":["YYYY-MM-DD"]},"tasks":[{"date":"YYYY-MM-DD","title":"","description":"","suggestedMinutes":30,"priority":"medium","checkCriteria":"一句自检"}],"suggestion":"一句鼓励，30字内"}`;
}

function sanitizeTask(raw: unknown): Omit<
  TaskItem,
  "id" | "completed" | "focusSeconds"
> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const date = String(r.date ?? "");
  const title = compactPlainText(r.title ?? "", 50);
  const description = compactPlainText(r.description ?? "", 80);
  const suggestedMinutes = Number(r.suggestedMinutes) || 30;
  const priorityRaw = String(r.priority ?? "medium");
  const priority: Priority =
    priorityRaw === "high" || priorityRaw === "low" ? priorityRaw : "medium";
  if (!date || !title) return null;
  const checkCriteria =
    compactPlainText(r.checkCriteria ?? "", 120) || undefined;
  const result: Omit<TaskItem, "id" | "completed" | "focusSeconds"> = {
    date,
    title,
    description,
    suggestedMinutes,
    priority,
  };
  if (checkCriteria) result.checkCriteria = checkCriteria;
  return result;
}

function finalizeReplan(
  req: ReplanRequest,
  tasks: Array<Omit<TaskItem, "id" | "completed" | "focusSeconds">>,
  aiSchedule?: PlanSchedule | null,
): { tasks: typeof tasks; schedule: PlanSchedule } {
  const today = localDateStr();
  const workdays = req.plan.workdays?.length
    ? req.plan.workdays
    : ["weekday", "weekend"];
  const budget = resolveBudget(req);
  const fallback = buildDefaultSchedule(today, req.plan.deadline, workdays);
  const schedule: PlanSchedule = {
    workDates: (aiSchedule?.workDates?.length
      ? aiSchedule.workDates
      : fallback.workDates
    ).slice().sort(),
    restDates: (aiSchedule?.restDates ?? fallback.restDates).slice().sort(),
    dailyBudgetMinutes: budget,
  };
  const first =
    snapToNextExecutableDay(today, workdays, req.plan.deadline) ?? today;
  if (!schedule.workDates.includes(first)) {
    schedule.workDates = [first, ...schedule.workDates].sort();
  }

  const withDates = tasks.map((task) => {
    let date = task.date;
    if (!schedule.workDates.includes(date)) {
      date =
        snapToNextExecutableDay(date, workdays, req.plan.deadline) ??
        schedule.workDates[0] ??
        today;
    }
    return { ...task, date, title: stripMarkdown(task.title), description: stripMarkdown(task.description) };
  });

  return {
    schedule,
    tasks: distributeTasksToWorkDates(
      withDates,
      schedule.workDates,
      Math.round(budget * 0.9),
      req.plan.deadline,
    ),
  };
}

function generateMockReplan(req: ReplanRequest): {
  tasks: Omit<TaskItem, "id" | "completed" | "focusSeconds">[];
  suggestion: string;
  schedule: PlanSchedule;
} {
  const unfinished = req.plan.tasks.filter((t) => !t.completed);
  const budget = resolveBudget(req);
  const raw = unfinished.map((t) => ({
    date: localDateStr(),
    title: t.title,
    description: t.description,
    suggestedMinutes: Math.min(budget, t.suggestedMinutes),
    priority: t.priority,
    checkCriteria:
      t.checkCriteria || `完成「${t.title}」并留下可核对的产出`,
    ...(t.steps ? { steps: t.steps } : {}),
  }));
  const finalized = finalizeReplan(req, raw, null);
  return {
    tasks: finalized.tasks,
    schedule: finalized.schedule,
    suggestion: "已根据你的反馈重新排期，明天继续加油！",
  };
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (!checkOrigin(req)) {
    return new Response("Forbidden", { status: 403 });
  }
  const auth = await requireUser();
  if (isAuthResponse(auth)) return auth;

  let body: ReplanRequest;
  try {
    body = (await req.json()) as ReplanRequest;
  } catch {
    return Response.json({ error: "无效的请求体" }, { status: 400 });
  }

  if (
    !body.plan?.id ||
    !body.plan.goal?.trim() ||
    !Array.isArray(body.plan.tasks) ||
    body.plan.tasks.length > 2_000 ||
    !Number.isFinite(Number(body.tomorrowMinutes)) ||
    Number(body.tomorrowMinutes) < 15 ||
    Number(body.tomorrowMinutes) > 600
  ) {
    return Response.json({ error: "缺少计划数据" }, { status: 400 });
  }
  const quota = await consumeAiQuota(auth.id, "replan", {
    testerMode: isTesterModeRequest(req),
  });
  if (!quota.allowed) {
    return Response.json(
      { error: `今日 AI 重排次数已用完（免费版每天 ${quota.limit} 次）` },
      { status: 429 },
    );
  }

  let completion;
  try {
    const ai = createAiClient();
    if (!ai) {
      throw new Error("AI client unavailable: missing DeepSeek key and Netlify AI Gateway key");
    }
    const { client, model } = ai;
    completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "你是计划重排助手，只输出 JSON，禁止 Markdown。" },
        { role: "user", content: buildPrompt(body) },
      ],
      temperature: 0.4,
      max_tokens: 2200,
      response_format: { type: "json_object" },
    }, { timeout: 8_000 });
  } catch (err) {
    console.warn("AI 调用失败，使用 mock 兜底:", err instanceof Error ? err.message : err);
    const mock = generateMockReplan(body);
    return Response.json({ ...mock, mock: true });
  }

  const content = completion.choices?.[0]?.message?.content ?? "";
  let parsed: { tasks?: unknown[]; suggestion?: string; schedule?: PlanSchedule };
  try {
    const cleaned = content
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/i, "")
      .trim();
    parsed = JSON.parse(cleaned);
  } catch {
    const mock = generateMockReplan(body);
    return Response.json({ ...mock, mock: true });
  }

  const arr = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  const tasks = arr
    .map(sanitizeTask)
    .filter((t): t is NonNullable<typeof t> => t !== null);

  if (tasks.length === 0) {
    const mock = generateMockReplan(body);
    return Response.json({ ...mock, mock: true });
  }

  const finalized = finalizeReplan(body, tasks, parsed.schedule ?? null);
  const result: ReplanResponse = {
    tasks: finalized.tasks,
    schedule: finalized.schedule,
    suggestion: stripMarkdown(
      String(parsed.suggestion ?? "已为你重新安排，继续加油！"),
    ).slice(0, 60),
  };
  return Response.json(result);
};

export const config: Config = {
  path: "/api/replan",
  method: "POST",
};
