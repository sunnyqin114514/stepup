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
  listExecutableDays,
  localDateStr,
  snapToNextExecutableDay,
} from "../../src/lib/scheduleDates";
import { stripMarkdown } from "../../src/lib/textSanitize";
import { checkOrigin, createAiClient } from "./_shared/aiClient";
import { buildFallbackStepsForTask } from "./_shared/taskDetail";
import { sanitizeFullTask } from "./_shared/taskSanitize";
import {
  consumeAiQuota,
  isAuthResponse,
  isTesterModeRequest,
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

function summarizeSteps(task: TaskItem): string {
  if (!Array.isArray(task.steps) || task.steps.length === 0) return "无步骤";
  return task.steps
    .slice(0, 3)
    .map((step) => {
      if (typeof step === "string") return stripMarkdown(step);
      return stripMarkdown(step.action || "");
    })
    .filter(Boolean)
    .join("；");
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
  const instruction = String(req.difficulty ?? "").trim();
  const concrete = hasConcreteInstruction(instruction);

  return `你是计划重排助手。根据用户指令动态调整剩余任务、任务内容与休息日。只输出合法 JSON，禁止 Markdown。

【目标】${req.plan.goal}
【截止日期】${req.plan.deadline}
【用户调整指令】${concrete ? instruction : "无具体指令（只重排日期与节奏，保持任务内容与步骤深度）"}
【本目标每日预算】${budget} 分钟
【全局每日上限】${Number(req.globalDailyCap) || budget} 分钟
【其他目标今日已占用】${Number(req.otherGoalsOccupiedMinutes) || 0} 分钟
【本目标完成率】${Number.isFinite(Number(req.goalCompletionRate)) ? `${req.goalCompletionRate}%` : "暂无"}
【基础】${req.plan.foundation || "未填写"}
【薄弱】${req.plan.weakness || "未填写"}
【可执行日偏好】${workdays.join("、")}，共 ${executable.length} 天
【推荐工作日样例】${schedule.workDates.slice(0, 8).join("、")}
【推荐休息日样例】${schedule.restDates.slice(0, 6).join("、") || "无"}

【未完成任务（含内容与步骤摘要，改写时必须基于这些细节）】
${unfinished
  .map(
    (t, index) =>
      `${index + 1}. ${t.date} | ${t.subject ? `[${stripMarkdown(t.subject)}] ` : ""}${stripMarkdown(t.title)} | ${t.suggestedMinutes}分钟 | ${t.priority}
  描述: ${stripMarkdown(t.description || "无")}
  步骤: ${summarizeSteps(t)}
  自检: ${stripMarkdown(t.checkCriteria || "无")}`,
  )
  .join("\n") || "（无）"}

规则：
0. ${
    concrete
      ? "有具体指令：必须改写相关任务的 title/description/steps 内容与排期，禁止只挪日期；可增减任务、调整科目先后。指令与下列规则冲突时以指令为准。"
      : "无具体指令：保持 title/description/steps 语义与深度，只调整 date/schedule/suggestedMinutes 节奏。"
  }
1. 只重排未完成任务；不要输出已完成任务。
2. 任务只能落在工作日；每天总分钟 ≤ ${Math.round(budget * 0.9)}；有任务日尽量用到预算 60%-90%。
3. 根据反馈动态调整：太累则增加休息日/降低每日量；状态好可略增强度。
4. 高优先级靠前；日期覆盖到截止前冲刺周；相邻有任务工作日间隔尽量 ≤ 2 天。
5. 输出 schedule.workDates 与 schedule.restDates。
6. 每个任务必须输出与默认拆解同级的具体化结构：subject、checkCriteria、steps(2-3项，含 action/goal/minutes/guide/microActions/blockers)。
7. title 是 8-25 字具体动作；description 30-60 字；纯文本，禁止 **。

输出：
{"schedule":{"workDates":["YYYY-MM-DD"],"restDates":["YYYY-MM-DD"]},"tasks":[{"date":"YYYY-MM-DD","subject":"科目或模块","title":"8-25字具体动作","description":"30-60字","suggestedMinutes":30,"priority":"medium","checkCriteria":"一句自检","steps":[{"action":"步骤标题","goal":"达成结果","minutes":20,"guide":"一句话","microActions":[{"text":"具体动作","material":"材料","sourceRef":"题号/段落","timeLimit":"15分钟"}],"checkCriteria":"本步自检","blockers":[{"problem":"卡点","solution":"解法"}]}],"topicTags":["标签"],"resourceSuggestions":["检索词"],"reviewIntervals":[3,7,14,30]}],"suggestion":"一句鼓励，30字内"}`;
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
    )
      .slice()
      .sort(),
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
    return {
      ...task,
      date,
      title: stripMarkdown(task.title),
      description: stripMarkdown(task.description),
    };
  });

  const detailed = inheritTaskDetails(
    withDates,
    req.plan.tasks.filter((t) => !t.completed),
  );

  return {
    schedule,
    tasks: distributeTasksToWorkDates(
      detailed,
      schedule.workDates,
      Math.round(budget * 0.9),
      req.plan.deadline,
    ),
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

  // 太累时：把部分工作日挪到休息，通过缩短预算日体现
  let scheduleOverride: PlanSchedule | null = null;
  if (concrete && /太累|休息|放慢/.test(instruction)) {
    const today = localDateStr();
    const workdays = req.plan.workdays?.length
      ? req.plan.workdays
      : ["weekday", "weekend"];
    const base = buildDefaultSchedule(today, req.plan.deadline, workdays);
    const workDates = base.workDates.filter((_, i) => i % 3 !== 2);
    const restDates = [
      ...base.restDates,
      ...base.workDates.filter((_, i) => i % 3 === 2),
    ].sort();
    scheduleOverride = {
      workDates: workDates.length ? workDates : base.workDates,
      restDates,
      dailyBudgetMinutes: budget,
    };
  }

  const finalized = finalizeReplan(req, raw, scheduleOverride);
  return {
    tasks: finalized.tasks,
    schedule: finalized.schedule,
    suggestion: concrete
      ? `已按「${instruction.slice(0, 18)}」调整任务内容与排期`
      : "已重新排期，任务执行细节保持不变",
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
      {
        error: `今日 AI 重排次数已用完（免费版每天 ${quota.limit} 次）`,
      },
      { status: 429 },
    );
  }

  let completion;
  try {
    const ai = createAiClient();
    if (!ai) {
      throw new Error(
        "AI client unavailable: missing DeepSeek key and Netlify AI Gateway key",
      );
    }
    const { client, model } = ai;
    completion = await client.chat.completions.create(
      {
        model,
        messages: [
          {
            role: "system",
            content:
              "你是计划重排助手。必须输出合法 JSON，任务需包含与首次拆解同级的 steps/microActions/blockers。禁止 Markdown。",
          },
          { role: "user", content: buildPrompt(body) },
        ],
        temperature: 0.35,
        max_tokens: 3200,
        response_format: { type: "json_object" },
      },
      { timeout: 12_000 },
    );
  } catch (err) {
    console.warn(
      "AI 调用失败，使用指令感知 mock 兜底:",
      err instanceof Error ? err.message : err,
    );
    const mock = generateMockReplan(body);
    return Response.json({ ...mock, mock: true });
  }

  const content = completion.choices?.[0]?.message?.content ?? "";
  let parsed: {
    tasks?: unknown[];
    suggestion?: string;
    schedule?: PlanSchedule;
  };
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
    .map(sanitizeFullTask)
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
