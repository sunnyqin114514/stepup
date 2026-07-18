import type { Config } from "@netlify/functions";
import type {
  PlanSchedule,
  ReplanRequest,
  ReplanResponse,
  TaskItem,
} from "../../src/types/plan";
import {
  buildDefaultSchedule,
  distributeTasksToWorkDates,
  localDateStr,
  resolveRestIntensity,
  snapToNextExecutableDay,
  tightenScheduleToTasks,
  type RestIntensity,
} from "../../src/lib/scheduleDates";
import { stripMarkdown } from "../../src/lib/textSanitize";
import { checkOrigin, createAiClient } from "./_shared/aiClient";
import { buildFallbackStepsForTask } from "./_shared/taskDetail";
import {
  commitAiQuota,
  isAuthResponse,
  isTesterModeRequest,
  peekAiQuota,
  requireUser,
} from "./_shared/auth";

function resolveBudget(req: ReplanRequest): number {
  const allocated = Number(req.allocatedDailyMinutes);
  if (Number.isFinite(allocated) && allocated >= 15) return Math.round(allocated);
  return Math.max(15, Math.round(Number(req.tomorrowMinutes) || 120));
}

function hasConcreteInstruction(difficulty: string | undefined): boolean {
  const note = String(difficulty ?? "").trim();
  if (!note) return false;
  if (note === "用户主动请求调整日程" || note === "无（按默认规则重排）") {
    return false;
  }
  return true;
}

type AiAdjustPlan = {
  restIntensity?: RestIntensity;
  minuteScale?: number;
  focusSubject?: string;
  suggestion?: string;
  rewrites?: Array<{
    match?: string;
    title?: string;
    description?: string;
    priority?: TaskItem["priority"];
    suggestedMinutes?: number;
  }>;
};

/** 精简提示：只让 AI 返回调整参数，不吐全量任务（避免超时落到本地算法） */
function buildPrompt(req: ReplanRequest): string {
  const unfinished = req.plan.tasks.filter((t) => !t.completed);
  const budget = resolveBudget(req);
  const instruction = String(req.difficulty ?? "").trim();
  const restIntensity = resolveRestIntensity(instruction);
  const titles = unfinished
    .slice(0, 16)
    .map((t, i) => `${i + 1}.${stripMarkdown(t.title)}`)
    .join("；");

  return `你是学习计划调整助手。根据用户指令输出「调整方案」JSON（不要输出全部任务列表）。禁止 Markdown。

【目标】${req.plan.goal}
【截止】${req.plan.deadline}
【每日预算】${budget} 分钟
【用户指令】${instruction}
【预判休息强度】${restIntensity}（recovery=多休，standard=标准，sprint=少休）
【任务标题样例】${titles || "无"}

规则：
1. restIntensity 必须是 recovery | standard | sprint 之一，且符合用户指令。
2. minuteScale：放慢约 0.7-0.85，加强约 1.1-1.2，默认 1。
3. focusSubject：若指令提到优先科目则填写，否则空字符串。
4. rewrites 最多 6 条：只改写与指令相关的任务；match 用原标题关键词。
5. suggestion 一句中文，说明休息/强度/内容如何变，≤28 字。

输出：
{"restIntensity":"recovery","minuteScale":0.8,"focusSubject":"","rewrites":[{"match":"关键词","title":"新标题","priority":"medium","suggestedMinutes":30}],"suggestion":"已增加休息并放慢节奏"}`;
}

function parseAiAdjustPlan(raw: unknown): AiAdjustPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const intensityRaw = String(obj.restIntensity ?? "").trim();
  const restIntensity: RestIntensity | undefined =
    intensityRaw === "recovery" ||
    intensityRaw === "standard" ||
    intensityRaw === "sprint"
      ? intensityRaw
      : undefined;
  const minuteScale = Number(obj.minuteScale);
  const rewrites = Array.isArray(obj.rewrites)
    ? obj.rewrites
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const r = item as Record<string, unknown>;
          const priority = String(r.priority ?? "");
          return {
            match: stripMarkdown(String(r.match ?? "")).slice(0, 40),
            title: r.title ? stripMarkdown(String(r.title)).slice(0, 50) : undefined,
            description: r.description
              ? stripMarkdown(String(r.description)).slice(0, 80)
              : undefined,
            priority:
              priority === "high" || priority === "medium" || priority === "low"
                ? (priority as TaskItem["priority"])
                : undefined,
            suggestedMinutes: Number.isFinite(Number(r.suggestedMinutes))
              ? Math.min(180, Math.max(15, Math.round(Number(r.suggestedMinutes))))
              : undefined,
          };
        })
        .filter((x): x is NonNullable<typeof x> => Boolean(x?.match))
        .slice(0, 6)
    : [];

  return {
    ...(restIntensity ? { restIntensity } : {}),
    ...(Number.isFinite(minuteScale) && minuteScale > 0.4 && minuteScale < 1.6
      ? { minuteScale }
      : {}),
    focusSubject: stripMarkdown(String(obj.focusSubject ?? "")).slice(0, 20),
    suggestion: stripMarkdown(String(obj.suggestion ?? "")).slice(0, 40),
    rewrites,
  };
}

/** 把 AI 精简方案套到原未完成任务上，再交给 finalize 排期 */
function applyAiAdjustPlan(
  unfinished: TaskItem[],
  plan: AiAdjustPlan,
  budget: number,
  instruction: string,
): Array<Omit<TaskItem, "id" | "completed" | "focusSeconds">> {
  const scale =
    Number.isFinite(Number(plan.minuteScale)) && Number(plan.minuteScale) > 0
      ? Number(plan.minuteScale)
      : /太累|放慢|休息|轻松/.test(instruction)
        ? 0.8
        : /加强|冲刺|加量/.test(instruction)
          ? 1.15
          : 1;
  const focus = String(plan.focusSubject ?? "").trim();
  const rewrites = plan.rewrites ?? [];

  return unfinished.map((t) => {
    let minutes = Math.min(
      budget,
      Math.max(20, Math.round(Number(t.suggestedMinutes) * scale)),
    );
    let priority = t.priority;
    let title = t.title;
    let description = t.description;
    let subject = t.subject;

    const hitRewrite = rewrites.find((r) => {
      const key = normalizeTitle(r.match);
      if (!key) return false;
      return (
        normalizeTitle(t.title).includes(key) ||
        normalizeSubject(t.subject).includes(key) ||
        key.includes(normalizeTitle(t.title).slice(0, 6))
      );
    });
    if (hitRewrite) {
      if (hitRewrite.title) title = hitRewrite.title;
      if (hitRewrite.description) description = hitRewrite.description;
      if (hitRewrite.priority) priority = hitRewrite.priority;
      if (hitRewrite.suggestedMinutes) {
        minutes = Math.min(budget, hitRewrite.suggestedMinutes);
      }
    }

    if (focus) {
      const hit =
        normalizeSubject(subject).includes(normalizeSubject(focus)) ||
        normalizeTitle(title).includes(normalizeSubject(focus));
      if (hit) priority = "high";
    }

    return {
      date: t.date || localDateStr(),
      title,
      description:
        description ||
        `围绕「${title}」完成一轮可检查练习。`,
      suggestedMinutes: minutes,
      priority,
      checkCriteria:
        t.checkCriteria || `完成「${title}」并留下可核对的产出`,
      ...(subject ? { subject } : {}),
      ...(t.steps ? { steps: t.steps } : {}),
      ...(t.topicTags?.length ? { topicTags: t.topicTags } : {}),
      ...(t.priorityReason ? { priorityReason: t.priorityReason } : {}),
      ...(t.sourceReason ? { sourceReason: t.sourceReason } : {}),
      ...(t.resourceSuggestions?.length
        ? { resourceSuggestions: t.resourceSuggestions }
        : {}),
      ...(t.reviewIntervals?.length
        ? { reviewIntervals: t.reviewIntervals }
        : {}),
    };
  });
}

function normalizeTitle(value: unknown): string {
  return stripMarkdown(String(value ?? ""))
    .replace(/\s+/g, "")
    .toLowerCase();
}

function normalizeSubject(value: unknown): string {
  return stripMarkdown(String(value ?? ""))
    .replace(/\s+/g, "")
    .toLowerCase();
}

function stepsAreRich(steps: TaskItem["steps"] | undefined): boolean {
  if (!Array.isArray(steps) || steps.length === 0) return false;
  return steps.some((step) => {
    if (typeof step === "string") return false;
    return Boolean(
      step.microActions?.length ||
        step.blockers?.length ||
        step.guide ||
        step.goal,
    );
  });
}

function inheritTaskDetails(
  tasks: Array<Omit<TaskItem, "id" | "completed" | "focusSeconds">>,
  originals: TaskItem[],
): Array<Omit<TaskItem, "id" | "completed" | "focusSeconds">> {
  const pool = originals.map((task, index) => ({
    task,
    key: normalizeTitle(task.title),
    subject: normalizeSubject(task.subject),
    index,
  }));
  const usedIndexes = new Set<number>();

  return tasks.map((task, index) => {
    const key = normalizeTitle(task.title);
    const subjectKey = normalizeSubject(task.subject);

    let source =
      pool.find((item) => item.key === key && !usedIndexes.has(item.index))
        ?.task ??
      pool.find(
        (item) =>
          !usedIndexes.has(item.index) &&
          item.key.length >= 6 &&
          key.length >= 6 &&
          (key.includes(item.key) || item.key.includes(key)),
      )?.task;

    if (!source && subjectKey) {
      source = pool.find(
        (item) =>
          !usedIndexes.has(item.index) &&
          item.subject &&
          item.subject === subjectKey,
      )?.task;
    }

    if (!source && index < pool.length && !usedIndexes.has(index)) {
      source = pool[index]?.task;
    }

    if (source) {
      const matched = pool.find((item) => item.task === source);
      if (matched) usedIndexes.add(matched.index);
    }

    const subject = task.subject || source?.subject;
    const checkCriteria =
      task.checkCriteria ||
      source?.checkCriteria ||
      `完成「${task.title}」并留下可核对的产出（笔记/错题/截图）`;

    // AI 已给出丰富 steps 时优先采用；否则继承原任务；再否则生成与默认拆解同级的兜底
    const steps = stepsAreRich(task.steps)
      ? task.steps
      : stepsAreRich(source?.steps)
        ? source?.steps
        : buildFallbackStepsForTask(
            task.title,
            subject,
            task.suggestedMinutes,
            checkCriteria,
          );

    return {
      ...task,
      description:
        task.description?.trim() ||
        source?.description ||
        `围绕「${task.title}」完成一轮可检查的练习并留下产出。`,
      ...(subject ? { subject } : {}),
      checkCriteria,
      steps,
      topicTags:
        task.topicTags?.length
          ? task.topicTags
          : source?.topicTags?.length
            ? source.topicTags
            : subject
              ? [subject, "自检"]
              : ["目标执行", "自检"],
      priorityReason:
        task.priorityReason ||
        source?.priorityReason ||
        "依据当前调整指令与目标推进需要",
      sourceReason: task.sourceReason || source?.sourceReason,
      resourceSuggestions:
        task.resourceSuggestions?.length
          ? task.resourceSuggestions
          : source?.resourceSuggestions?.length
            ? source.resourceSuggestions
            : subject
              ? [`${subject} 高频题`, `${subject} 真题解析`, "错题复盘表"]
              : ["知识库中与当前任务最相关的资料"],
      reviewIntervals:
        task.reviewIntervals?.length
          ? task.reviewIntervals
          : source?.reviewIntervals?.length
            ? source.reviewIntervals
            : [3, 7, 14, 30],
    };
  });
}

function finalizeReplan(
  req: ReplanRequest,
  tasks: Array<Omit<TaskItem, "id" | "completed" | "focusSeconds">>,
  _aiSchedule?: PlanSchedule | null,
  restIntensity?: RestIntensity,
): { tasks: typeof tasks; schedule: PlanSchedule } {
  const today = localDateStr();
  const workdays = req.plan.workdays?.length
    ? req.plan.workdays
    : ["weekday", "weekend"];
  const budget = resolveBudget(req);
  const intensity =
    restIntensity ?? resolveRestIntensity(String(req.difficulty ?? ""));
  // 日历由算法按休息强度生成，保证指令会真实改变休息日/节奏
  void _aiSchedule;
  let schedule: PlanSchedule = {
    ...buildDefaultSchedule(today, req.plan.deadline, workdays, {
      restIntensity: intensity,
    }),
    dailyBudgetMinutes: budget,
  };
  const first =
    snapToNextExecutableDay(today, workdays, req.plan.deadline) ?? today;
  if (!schedule.workDates.includes(first)) {
    schedule.workDates = [first, ...schedule.workDates].sort();
    schedule.restDates = schedule.restDates.filter((d) => d !== first);
  }

  const withDates = tasks.map((task) => ({
    ...task,
    date: first,
    title: stripMarkdown(task.title),
    description: stripMarkdown(task.description),
  }));

  const detailed = inheritTaskDetails(
    withDates,
    req.plan.tasks.filter((t) => !t.completed),
  );

  const distributed = distributeTasksToWorkDates(
    detailed,
    schedule.workDates,
    Math.round(budget * 0.9),
    req.plan.deadline,
  );
  schedule = tightenScheduleToTasks(
    schedule,
    distributed.map((t) => t.date),
  );

  return {
    schedule,
    tasks: distributed,
  };
}

function applyInstructionHeuristics(
  unfinished: TaskItem[],
  instruction: string,
  budget: number,
): Array<Omit<TaskItem, "id" | "completed" | "focusSeconds">> {
  const note = instruction.trim();
  const tired = /太累|放慢|减少|轻松|休息|降强|降负/.test(note);
  const intensify = /加强|加量|加速|更拼|冲刺|密集/.test(note);
  const subjectMatch = note.match(
    /(?:提前|优先|加强|多练|主攻|先做)\s*([^\s,，。；]{1,12})/,
  );
  const focusSubject = subjectMatch?.[1]?.trim();

  let tasks = unfinished.map((t) => {
    let minutes = Math.min(budget, t.suggestedMinutes);
    let priority = t.priority;
    let title = t.title;
    let description = t.description;
    let subject = t.subject;

    if (tired) {
      minutes = Math.max(20, Math.round(minutes * 0.75));
      if (priority === "high") priority = "medium";
    } else if (intensify) {
      minutes = Math.min(budget, Math.round(minutes * 1.15));
      if (priority === "low") priority = "medium";
      if (priority === "medium") priority = "high";
    }

    if (focusSubject) {
      const hit =
        normalizeSubject(subject).includes(normalizeSubject(focusSubject)) ||
        normalizeTitle(title).includes(normalizeSubject(focusSubject)) ||
        normalizeTitle(description).includes(normalizeSubject(focusSubject));
      if (hit) {
        priority = "high";
        title = title.includes("优先") ? title : `优先推进：${title}`.slice(0, 50);
        description = `按调整指令优先安排「${focusSubject}」：${description || title}`.slice(
          0,
          80,
        );
      } else if (/推后|延后|少做|先不做/.test(note)) {
        priority = "low";
      }
    }

    // 指令要求改写内容时，给 steps 打上可感知的更新，避免只挪日期
    const checkCriteria =
      t.checkCriteria || `完成「${title}」并留下可核对的产出`;
    const baseSteps =
      stepsAreRich(t.steps)
        ? t.steps
        : buildFallbackStepsForTask(title, subject, minutes, checkCriteria);
    const steps =
      hasConcreteInstruction(note) && Array.isArray(baseSteps)
        ? baseSteps.map((step, stepIndex) => {
            if (typeof step === "string") {
              return {
                action: step,
                guide: `按指令「${note.slice(0, 24)}」执行本步`,
              };
            }
            return {
              ...step,
              guide:
                step.guide ||
                `1.按调整指令准备材料；2.完成限时练习；3.留下可检查产出`,
              goal: step.goal || `完成「${title}」第 ${stepIndex + 1} 步`,
            };
          })
        : baseSteps;

    return {
      date: t.date || localDateStr(),
      title,
      description:
        description ||
        `围绕「${title}」完成一轮可检查练习（已按调整指令更新安排）。`,
      suggestedMinutes: minutes,
      priority,
      checkCriteria,
      ...(subject ? { subject } : {}),
      ...(steps ? { steps } : {}),
      ...(t.topicTags?.length ? { topicTags: t.topicTags } : {}),
      ...(t.priorityReason ? { priorityReason: t.priorityReason } : {}),
      ...(t.sourceReason ? { sourceReason: t.sourceReason } : {}),
      ...(t.resourceSuggestions?.length
        ? { resourceSuggestions: t.resourceSuggestions }
        : {}),
      ...(t.reviewIntervals?.length
        ? { reviewIntervals: t.reviewIntervals }
        : {}),
    };
  });

  if (focusSubject) {
    tasks = [...tasks].sort((a, b) => {
      const aHit =
        normalizeSubject(a.subject).includes(normalizeSubject(focusSubject)) ||
        normalizeTitle(a.title).includes(normalizeSubject(focusSubject))
          ? 1
          : 0;
      const bHit =
        normalizeSubject(b.subject).includes(normalizeSubject(focusSubject)) ||
        normalizeTitle(b.title).includes(normalizeSubject(focusSubject))
          ? 1
          : 0;
      return bHit - aHit;
    });
  }

  return tasks;
}

function generateMockReplan(req: ReplanRequest): {
  tasks: Omit<TaskItem, "id" | "completed" | "focusSeconds">[];
  suggestion: string;
  schedule: PlanSchedule;
} {
  const unfinished = req.plan.tasks.filter((t) => !t.completed);
  const budget = resolveBudget(req);
  const instruction = String(req.difficulty ?? "").trim();
  const concrete = hasConcreteInstruction(instruction);
  const raw = concrete
    ? applyInstructionHeuristics(unfinished, instruction, budget)
    : unfinished.map((t) => ({
        date: t.date || localDateStr(),
        title: t.title,
        description: t.description,
        suggestedMinutes: Math.min(budget, t.suggestedMinutes),
        priority: t.priority,
        checkCriteria:
          t.checkCriteria || `完成「${t.title}」并留下可核对的产出`,
        ...(t.subject ? { subject: t.subject } : {}),
        ...(t.steps ? { steps: t.steps } : {}),
        ...(t.topicTags?.length ? { topicTags: t.topicTags } : {}),
        ...(t.priorityReason ? { priorityReason: t.priorityReason } : {}),
        ...(t.sourceReason ? { sourceReason: t.sourceReason } : {}),
        ...(t.resourceSuggestions?.length
          ? { resourceSuggestions: t.resourceSuggestions }
          : {}),
        ...(t.reviewIntervals?.length
          ? { reviewIntervals: t.reviewIntervals }
          : {}),
      }));

  const intensity = resolveRestIntensity(instruction);
  const finalized = finalizeReplan(req, raw, null, intensity);
  const restCount = finalized.schedule.restDates?.length ?? 0;
  return {
    tasks: finalized.tasks,
    schedule: finalized.schedule,
    suggestion: concrete
      ? `已按「${instruction.slice(0, 16)}」调整（休息日 ${restCount} 天）`
      : `已重排节奏（休息日 ${restCount} 天）`,
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
  const instruction = String(body.difficulty ?? "").trim();
  const unfinished = body.plan.tasks.filter((t) => !t.completed);
  const budget = resolveBudget(body);

  // 无具体指令：本地按标准节奏重排，不占 AI 重排额度
  if (!hasConcreteInstruction(instruction)) {
    const local = generateMockReplan(body);
    return Response.json({ ...local, mock: false });
  }

  const testerMode = isTesterModeRequest(req);
  const quota = await peekAiQuota(auth.id, "replan", { testerMode });
  if (!quota.allowed) {
    return Response.json(
      {
        error: `今日 AI 重排次数已用完（免费版每天 ${quota.limit} 次）`,
      },
      { status: 429 },
    );
  }

  // 本地函数硬限约 30s：精简方案约 1–3s；留足预算让 API key 稳定打到 DeepSeek
  const AI_BUDGET_MS = 22_000;
  const raceDeadline = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`AI deadline exceeded (${ms}ms)`)),
            ms,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  let aiPlan: AiAdjustPlan | null = null;
  try {
    const ai = createAiClient();
    if (!ai) {
      throw new Error(
        "AI client unavailable: missing DeepSeek key and Netlify AI Gateway key",
      );
    }
    const { client, model } = ai;
    const completion = await raceDeadline(
      client.chat.completions.create(
        {
          model,
          messages: [
            {
              role: "system",
              content:
                "你是学习计划调整助手。只输出精简调整方案 JSON（restIntensity/minuteScale/rewrites/suggestion），禁止输出完整 tasks 数组。",
            },
            { role: "user", content: buildPrompt(body) },
          ],
          temperature: 0.25,
          max_tokens: 700,
          response_format: { type: "json_object" },
        },
        { timeout: AI_BUDGET_MS },
      ),
      AI_BUDGET_MS,
    );
    const content = completion.choices?.[0]?.message?.content ?? "";
    const cleaned = content
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/i, "")
      .trim();
    aiPlan = parseAiAdjustPlan(JSON.parse(cleaned));
    if (!aiPlan) {
      throw new Error("AI adjust plan empty");
    }
  } catch (err) {
    console.warn(
      "AI 调整方案失败，回退本地启发式:",
      err instanceof Error ? err.message : err,
    );
    const mock = generateMockReplan(body);
    return Response.json({ ...mock, mock: true });
  }

  const intensity =
    aiPlan.restIntensity ?? resolveRestIntensity(instruction);
  const tasks = applyAiAdjustPlan(unfinished, aiPlan, budget, instruction);
  if (tasks.length === 0) {
    const mock = generateMockReplan(body);
    return Response.json({ ...mock, mock: true });
  }

  const finalized = finalizeReplan(body, tasks, null, intensity);
  const restCount = finalized.schedule.restDates?.length ?? 0;
  const result: ReplanResponse = {
    tasks: finalized.tasks,
    schedule: finalized.schedule,
    suggestion: stripMarkdown(
      String(
        aiPlan.suggestion ||
          `已按 AI 调整：休息日 ${restCount} 天（${intensity}）`,
      ),
    ).slice(0, 60),
  };
  // 真实走了 AI 才扣次；超时本地启发式（mock）不烧额度
  await commitAiQuota(auth.id, "replan", { testerMode });
  return Response.json(result);
};

export const config: Config = {
  path: "/api/replan",
  method: "POST",
};
