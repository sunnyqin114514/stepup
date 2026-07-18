import type {
  Achievement,
  BacklogItem,
  DecomposeRequest,
  Plan,
  Priority,
  ReviewCycle,
  ReviewLog,
  TaskAiReview,
  TaskItem,
  Workspace,
} from "../types/plan";
import {
  FREE_ACTIVE_GOAL_LIMIT,
  REVIEW_CYCLE_DAYS,
} from "../types/plan";

const KEY_PLAN_LEGACY = "stepup.plan";
const KEY_WORKSPACE = "stepup.workspace";
const KEY_REVIEWS = "stepup.reviews";
const KEY_TASK_AI_REVIEWS = "stepup.taskAiReviews";
const KEY_BACKLOG = "stepup.backlog";
const KEY_PRO = "stepup.pro";
const KEY_TESTER_MODE = "stepup.testerMode";
const KEY_BACKLOG_PROMPT = "stepup.backlogPromptDate";
const VERSION = 3;
let workspaceSyncTimer: number | null = null;
let serverProEntitlement = false;
let storageScope =
  import.meta.env.DEV
    ? "dev-user-local-only"
    : localStorage.getItem("stepup.authScope") ?? "anonymous";

function scopedKey(base: string): string {
  return `${base}:${storageScope}`;
}

export function userStorageKey(base: string): string {
  return scopedKey(base);
}

function legacyCache(base: string): string | null {
  if (storageScope === "anonymous") return null;
  const claimedBy = localStorage.getItem("stepup.legacyClaimedBy");
  if (claimedBy && claimedBy !== storageScope) return null;
  const value = localStorage.getItem(base);
  if (value && !claimedBy) {
    localStorage.setItem("stepup.legacyClaimedBy", storageScope);
  }
  return value;
}

export function configureStorageUser(userId: string | null): void {
  storageScope = userId || "anonymous";
  if (userId) localStorage.setItem("stepup.authScope", userId);
  else localStorage.removeItem("stepup.authScope");
}

/** 生产环境由服务端 user_entitlements 注入；本地仍使用演示试用开关。 */
export function configureProEntitlement(pro: boolean): void {
  serverProEntitlement = Boolean(pro);
}

export function isTesterModeEnabled(): boolean {
  return localStorage.getItem(KEY_TESTER_MODE) === "true";
}

export function setTesterModeEnabled(value: boolean): void {
  localStorage.setItem(KEY_TESTER_MODE, value ? "true" : "false");
  window.dispatchEvent(new Event("stepup:tester-mode-change"));
}

type WorkspaceEnvelope = { v: number; workspace: Workspace };
type ReviewsEnvelope = { v: number; reviews: ReviewLog[] };
type TaskAiReviewsEnvelope = { v: number; items: TaskAiReview[] };
type BacklogEnvelope = { v: number; items: BacklogItem[] };
type LegacyPlanEnvelope = { v: number; plan: Plan | null };

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 本地日期字符串 YYYY-MM-DD（修复 UTC 时区 bug） */
function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayStr(): string {
  return localDateStr(new Date());
}

export function uid(): string {
  return (
    Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
  );
}

export function emptyWorkspace(): Workspace {
  return { plans: [], activePlanId: null, adhocTasks: [] };
}

/** 加载工作区；自动迁移旧版单 plan */
export function loadWorkspace(): Workspace {
  const env = safeParse<WorkspaceEnvelope | null>(
    localStorage.getItem(scopedKey(KEY_WORKSPACE)) ?? legacyCache(KEY_WORKSPACE),
    null
  );
  if (env?.workspace) {
    return {
      plans: env.workspace.plans ?? [],
      activePlanId: env.workspace.activePlanId ?? null,
      adhocTasks: env.workspace.adhocTasks ?? [],
    };
  }

  // 迁移旧 stepup.plan
  const legacy = safeParse<LegacyPlanEnvelope | null>(
    localStorage.getItem(scopedKey(KEY_PLAN_LEGACY)) ?? legacyCache(KEY_PLAN_LEGACY),
    null
  );
  if (legacy?.plan) {
    const plan = {
      ...legacy.plan,
      status: legacy.plan.status ?? ("active" as const),
      tasks: legacy.plan.tasks.map((t) => ({
        ...t,
        source: t.source ?? ("goal" as const),
        goalId: t.goalId ?? legacy.plan!.id,
      })),
    };
    const ws: Workspace = {
      plans: [plan],
      activePlanId: plan.id,
      adhocTasks: [],
    };
    saveWorkspace(ws);
    return ws;
  }

  return emptyWorkspace();
}

export function saveWorkspace(ws: Workspace): void {
  const env: WorkspaceEnvelope = { v: VERSION, workspace: ws };
  localStorage.setItem(scopedKey(KEY_WORKSPACE), JSON.stringify(env));
  if (workspaceSyncTimer !== null) window.clearTimeout(workspaceSyncTimer);
  workspaceSyncTimer = window.setTimeout(() => {
    void syncWorkspaceToServer(ws);
  }, 500);
}

/** 用服务端快照恢复工作区，不触发反向同步。 */
export function replaceWorkspaceFromServer(ws: Workspace): Workspace {
  const normalized: Workspace = {
    plans: Array.isArray(ws.plans) ? ws.plans : [],
    activePlanId: ws.activePlanId ?? ws.plans?.[0]?.id ?? null,
    adhocTasks: Array.isArray(ws.adhocTasks) ? ws.adhocTasks : [],
  };
  const env: WorkspaceEnvelope = { v: VERSION, workspace: normalized };
  localStorage.setItem(scopedKey(KEY_WORKSPACE), JSON.stringify(env));
  return normalized;
}

/** 合并服务端新建的补强/复习/知识库任务，保持服务端 task id。 */
export function mergeServerTask(task: TaskItem): Workspace {
  const ws = loadWorkspace();
  const exists = getAllTasks(ws).some((item) => item.id === task.id);
  if (exists) return ws;
  if (task.goalId) {
    const plan = ws.plans.find((item) => item.id === task.goalId);
    if (plan) {
      plan.tasks = [...plan.tasks, { ...task, source: "goal" }];
      saveWorkspace(ws);
      return ws;
    }
  }
  ws.adhocTasks = [
    ...ws.adhocTasks,
    { ...task, source: "adhoc", goalId: undefined },
  ];
  saveWorkspace(ws);
  return ws;
}

async function syncWorkspaceToServer(workspace: Workspace): Promise<void> {
  try {
    const response = await fetch("/api/workspace", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(isTesterModeEnabled() ? { "X-StepUp-Tester-Mode": "true" } : {}),
      },
      body: JSON.stringify({ action: "sync", workspace }),
    });
    if (!response.ok) throw new Error(`工作区同步失败 (${response.status})`);
  } catch (error) {
    console.error("工作区服务端同步失败，本地副本保留并将在下次修改时重试", error);
  }
}

/** @deprecated 兼容旧调用：返回当前激活的 plan */
export function loadPlan(): Plan | null {
  const ws = loadWorkspace();
  if (ws.activePlanId) {
    return ws.plans.find((p) => p.id === ws.activePlanId) ?? ws.plans[0] ?? null;
  }
  return ws.plans[0] ?? null;
}

/** @deprecated 兼容旧调用：更新当前激活 plan */
export function savePlan(plan: Plan | null): void {
  const ws = loadWorkspace();
  if (!plan) {
    if (ws.activePlanId) {
      ws.plans = ws.plans.filter((p) => p.id !== ws.activePlanId);
      ws.activePlanId = ws.plans[0]?.id ?? null;
    }
    saveWorkspace(ws);
    return;
  }
  const idx = ws.plans.findIndex((p) => p.id === plan.id);
  if (idx >= 0) {
    ws.plans[idx] = plan;
  } else {
    ws.plans.push(plan);
  }
  ws.activePlanId = plan.id;
  saveWorkspace(ws);
}

export function getActivePlans(ws?: Workspace): Plan[] {
  const w = ws ?? loadWorkspace();
  return w.plans.filter((p) => (p.status ?? "active") === "active");
}

export function canAddActiveGoal(ws?: Workspace): boolean {
  if (isProUnlocked()) return true;
  const active = getActivePlans(ws);
  return active.length < FREE_ACTIVE_GOAL_LIMIT;
}

export function upsertPlan(plan: Plan): Workspace {
  const ws = loadWorkspace();
  const idx = ws.plans.findIndex((p) => p.id === plan.id);
  if (idx >= 0) {
    ws.plans[idx] = plan;
  } else {
    ws.plans.push(plan);
  }
  ws.activePlanId = plan.id;
  saveWorkspace(ws);
  return ws;
}

export function setActivePlanId(planId: string): Workspace {
  const ws = loadWorkspace();
  if (ws.plans.some((p) => p.id === planId)) {
    ws.activePlanId = planId;
    saveWorkspace(ws);
  }
  return ws;
}

export function removePlan(planId: string): Workspace {
  const ws = loadWorkspace();
  const oldTaskIds = new Set(
    ws.plans.find((plan) => plan.id === planId)?.tasks.map((task) => task.id) ?? [],
  );
  ws.plans = ws.plans.filter((p) => p.id !== planId);
  if (ws.activePlanId === planId) {
    ws.activePlanId = ws.plans[0]?.id ?? null;
  }
  clearPlanRelatedLocalState(planId, oldTaskIds);
  saveWorkspace(ws);
  return ws;
}

export function clearPlanRelatedLocalState(
  planId: string,
  oldTaskIdsInput?: Iterable<string>,
): void {
  const oldTaskIds = new Set(oldTaskIdsInput ?? []);

  const backlog = loadBacklog();
  saveBacklog(
    backlog.filter(
      (item) => item.goalId !== planId && !oldTaskIds.has(item.taskId),
    ),
  );

  if (oldTaskIds.size > 0) {
    saveTaskAiReviews(
      loadTaskAiReviews().filter((review) => !oldTaskIds.has(review.taskId)),
    );
  }

  const reviews = loadReviews()
    .map((review) => {
      const completedIds = review.completedIds.filter((id) => !oldTaskIds.has(id));
      const unfinishedIds = review.unfinishedIds.filter((id) => !oldTaskIds.has(id));
      const removedCount =
        review.completedIds.length +
        review.unfinishedIds.length -
        completedIds.length -
        unfinishedIds.length;
      if (removedCount <= 0) return review;
      const completedCount = Math.min(completedIds.length, review.completedCount);
      const totalCount = Math.max(
        completedIds.length + unfinishedIds.length,
        review.totalCount - removedCount,
      );
      return {
        ...review,
        completedIds,
        unfinishedIds,
        // 旧目标重拆后，无法可靠按 id 反查标题，直接清除旧未完成标题，避免复盘页继续展示旧目标文案。
        unfinishedTitles: [],
        completedCount,
        totalCount,
      };
    })
    .filter(
      (review) =>
        review.completedIds.length > 0 ||
        review.unfinishedIds.length > 0 ||
        review.action === "manual_note",
    );
  saveReviews(reviews);
}

export function setPlanStatus(
  planId: string,
  status: Plan["status"]
): Workspace {
  const ws = loadWorkspace();
  ws.plans = ws.plans.map((p) =>
    p.id === planId ? { ...p, status } : p
  );
  saveWorkspace(ws);
  return ws;
}

/** 所有任务（各目标 + 临时）扁平化，带 goalTitle */
export type DayTask = TaskItem & { goalTitle?: string };

export function getAllTasks(ws?: Workspace): DayTask[] {
  const w = ws ?? loadWorkspace();
  const fromGoals: DayTask[] = w.plans.flatMap((p) =>
    p.tasks.map((t) => ({
      ...t,
      source: t.source ?? "goal",
      goalId: t.goalId ?? p.id,
      goalTitle: p.goal,
    }))
  );
  const fromAdhoc: DayTask[] = w.adhocTasks.map((t) => ({
    ...t,
    source: "adhoc" as const,
    goalTitle: undefined,
  }));
  return [...fromGoals, ...fromAdhoc];
}

export function getTodayTasksFromWorkspace(ws?: Workspace): DayTask[] {
  const today = todayStr();
  const deferredIds = new Set(
    getPendingBacklog()
      .filter((b) => b.sourceDate === today)
      .map((b) => b.taskId)
  );
  return getAllTasks(ws).filter(
    (t) => t.date === today && !deferredIds.has(t.id)
  );
}

export function getTomorrowTasksFromWorkspace(ws?: Workspace): DayTask[] {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const tomorrow = localDateStr(d);
  return getAllTasks(ws).filter((t) => t.date === tomorrow && !t.completed);
}

/** 更新任意任务（在某 plan 或 adhoc 中） */
export function updateTaskEverywhere(
  taskId: string,
  patch: Partial<TaskItem>
): Workspace {
  const ws = loadWorkspace();
  let found = false;
  ws.plans = ws.plans.map((p) => {
    const idx = p.tasks.findIndex((t) => t.id === taskId);
    if (idx < 0) return p;
    found = true;
    const tasks = [...p.tasks];
    tasks[idx] = { ...tasks[idx], ...patch };
    return { ...p, tasks };
  });
  if (!found) {
    ws.adhocTasks = ws.adhocTasks.map((t) =>
      t.id === taskId ? { ...t, ...patch } : t
    );
  }
  saveWorkspace(ws);
  return ws;
}

export function addAdhocTask(input: {
  title: string;
  suggestedMinutes?: number;
  description?: string;
  goalId?: string; // 可选挂到某目标
}): Workspace {
  const ws = loadWorkspace();
  const today = todayStr();
  const task: TaskItem = {
    id: uid(),
    date: today,
    title: input.title.trim(),
    description: input.description?.trim() ?? "",
    suggestedMinutes: input.suggestedMinutes ?? 30,
    priority: "medium",
    completed: false,
    focusSeconds: 0,
    source: input.goalId ? "goal" : "adhoc",
    goalId: input.goalId,
  };

  if (input.goalId) {
    const plan = ws.plans.find((p) => p.id === input.goalId);
    if (plan) {
      plan.tasks = [...plan.tasks, { ...task, source: "goal" }];
      saveWorkspace(ws);
      return ws;
    }
  }

  ws.adhocTasks = [...ws.adhocTasks, { ...task, source: "adhoc", goalId: undefined }];
  saveWorkspace(ws);
  return ws;
}

export function loadReviews(): ReviewLog[] {
  const env = safeParse<ReviewsEnvelope | null>(
    localStorage.getItem(scopedKey(KEY_REVIEWS)) ?? legacyCache(KEY_REVIEWS),
    null
  );
  return env?.reviews ?? [];
}

export function saveReviews(reviews: ReviewLog[]): void {
  const env: ReviewsEnvelope = { v: VERSION, reviews };
  localStorage.setItem(scopedKey(KEY_REVIEWS), JSON.stringify(env));
}

export function appendReview(review: ReviewLog): void {
  const reviews = loadReviews();
  const filtered = reviews.filter(
    (r) => !(r.date === review.date && r.action === review.action)
  );
  filtered.push(review);
  saveReviews(filtered);
}

export function loadTaskAiReviews(): TaskAiReview[] {
  const env = safeParse<TaskAiReviewsEnvelope | null>(
    localStorage.getItem(scopedKey(KEY_TASK_AI_REVIEWS)) ?? legacyCache(KEY_TASK_AI_REVIEWS),
    null
  );
  return env?.items ?? [];
}

export function saveTaskAiReviews(items: TaskAiReview[]): void {
  const env: TaskAiReviewsEnvelope = { v: VERSION, items };
  localStorage.setItem(scopedKey(KEY_TASK_AI_REVIEWS), JSON.stringify(env));
}

/** 追加一条任务 AI 复盘；同 taskId 保留最新一条 */
export function appendTaskAiReview(item: TaskAiReview): void {
  const list = loadTaskAiReviews().filter((x) => x.taskId !== item.taskId);
  list.unshift(item);
  saveTaskAiReviews(list.slice(0, 50));
}

export function loadBacklog(): BacklogItem[] {
  const env = safeParse<BacklogEnvelope | null>(
    localStorage.getItem(scopedKey(KEY_BACKLOG)) ?? legacyCache(KEY_BACKLOG),
    null
  );
  return env?.items ?? [];
}

export function saveBacklog(items: BacklogItem[]): void {
  const env: BacklogEnvelope = { v: VERSION, items };
  localStorage.setItem(scopedKey(KEY_BACKLOG), JSON.stringify(env));
}

export function getPendingBacklog(): BacklogItem[] {
  return loadBacklog().filter((b) => b.status === "pending");
}

export function pushUnfinishedToBacklog(
  unfinished: DayTask[],
  reason: BacklogItem["reason"],
  note?: string
): BacklogItem[] {
  const existing = loadBacklog();
  const today = todayStr();
  const existingTaskIds = new Set(
    existing.filter((b) => b.status === "pending").map((b) => b.taskId)
  );

  const created: BacklogItem[] = unfinished
    .filter((t) => !existingTaskIds.has(t.id))
    .map((t) => ({
      id: uid(),
      taskId: t.id,
      title: t.title,
      description: t.description,
      suggestedMinutes: t.suggestedMinutes,
      priority: t.priority,
      goalId: t.goalId,
      goalTitle: t.goalTitle,
      subGoal: t.subGoal,
      source: t.source ?? (t.goalId ? "goal" : "adhoc"),
      originalDate: t.date,
      sourceDate: today,
      reason,
      note,
      status: "pending" as const,
      createdAt: new Date().toISOString(),
    }));

  const next = [...existing, ...created];
  saveBacklog(next);
  return created;
}

/** 将 backlog 项加入今日（写回原 plan 或 adhoc） */
export function addBacklogItemToToday(backlogId: string): Workspace {
  const ws = loadWorkspace();
  const items = loadBacklog();
  const item = items.find((b) => b.id === backlogId);
  if (!item || item.status !== "pending") return ws;

  const today = todayStr();
  const patch: Partial<TaskItem> = {
    date: today,
    completed: false,
    fromBacklog: true,
  };

  let found = false;
  if (item.goalId) {
    ws.plans = ws.plans.map((p) => {
      if (p.id !== item.goalId) return p;
      const idx = p.tasks.findIndex((t) => t.id === item.taskId);
      if (idx >= 0) {
        found = true;
        const tasks = [...p.tasks];
        tasks[idx] = { ...tasks[idx], ...patch };
        return { ...p, tasks };
      }
      found = true;
      return {
        ...p,
        tasks: [
          ...p.tasks,
          {
            id: item.taskId,
            date: today,
            title: item.title,
            description: item.description,
            suggestedMinutes: item.suggestedMinutes,
            priority: item.priority,
            completed: false,
            focusSeconds: 0,
            source: "goal" as const,
            goalId: item.goalId,
            subGoal: item.subGoal,
            fromBacklog: true,
          },
        ],
      };
    });
  }

  if (!found) {
    const aidx = ws.adhocTasks.findIndex((t) => t.id === item.taskId);
    if (aidx >= 0) {
      ws.adhocTasks[aidx] = { ...ws.adhocTasks[aidx], ...patch };
    } else {
      ws.adhocTasks.push({
        id: item.taskId,
        date: today,
        title: item.title,
        description: item.description,
        suggestedMinutes: item.suggestedMinutes,
        priority: item.priority,
        completed: false,
        focusSeconds: 0,
        source: "adhoc",
        fromBacklog: true,
      });
    }
  }

  saveWorkspace(ws);
  saveBacklog(
    items.map((b) =>
      b.id === backlogId ? { ...b, status: "added" as const } : b
    )
  );
  return ws;
}

export function cancelBacklogItem(backlogId: string): void {
  const items = loadBacklog();
  saveBacklog(
    items.map((b) =>
      b.id === backlogId ? { ...b, status: "cancelled" as const } : b
    )
  );
}

export function getBacklogPromptDate(): string | null {
  return localStorage.getItem(scopedKey(KEY_BACKLOG_PROMPT));
}

export function setBacklogPromptDate(date: string): void {
  localStorage.setItem(scopedKey(KEY_BACKLOG_PROMPT), date);
}

// ===== Pro 会员与试用期 =====
const KEY_PRO_TRIAL_START = "stepup.proTrialStart";
const TRIAL_DAYS = 7;

export function isProUnlocked(): boolean {
  if (isTesterModeEnabled()) return true;
  if (!import.meta.env.DEV) return serverProEntitlement;
  if (localStorage.getItem(KEY_PRO) !== "true") return false;
  // 检查试用期是否过期
  const trialStart = localStorage.getItem(KEY_PRO_TRIAL_START);
  if (trialStart) {
    const elapsed = Date.now() - new Date(trialStart).getTime();
    if (elapsed > TRIAL_DAYS * 86_400_000) {
      // 试用过期，自动降级
      localStorage.setItem(KEY_PRO, "false");
      localStorage.removeItem(KEY_PRO_TRIAL_START);
      return false;
    }
  }
  return true;
}

export function setProUnlocked(value: boolean): void {
  if (!import.meta.env.DEV) {
    console.error("生产环境禁止通过 localStorage 修改 Pro 权益");
    return;
  }
  localStorage.setItem(KEY_PRO, value ? "true" : "false");
  if (value) {
    if (!localStorage.getItem(KEY_PRO_TRIAL_START)) {
      localStorage.setItem(KEY_PRO_TRIAL_START, new Date().toISOString());
    }
  } else {
    localStorage.removeItem(KEY_PRO_TRIAL_START);
  }
}

export function getTrialInfo(): { active: boolean; daysRemaining: number } {
  if (localStorage.getItem(KEY_PRO) !== "true")
    return { active: false, daysRemaining: 0 };
  const trialStart = localStorage.getItem(KEY_PRO_TRIAL_START);
  if (!trialStart) return { active: true, daysRemaining: TRIAL_DAYS };
  const remaining =
    TRIAL_DAYS * 86_400_000 - (Date.now() - new Date(trialStart).getTime());
  if (remaining <= 0) return { active: false, daysRemaining: 0 };
  return { active: true, daysRemaining: Math.ceil(remaining / 86_400_000) };
}

// ===== Freemium AI 调用次数限制 =====
const KEY_AI_COUNTS = "stepup.aiCounts";
export const FREE_DECOMPOSE_LIMIT = 3;
export const FREE_REPLAN_LIMIT = 1;

type AiCounts = { date: string; decompose: number; replan: number };

function getAiCounts(): AiCounts {
  const today = todayStr();
  const raw = safeParse<AiCounts | null>(
    localStorage.getItem(scopedKey(KEY_AI_COUNTS)),
    null
  );
  if (!raw || raw.date !== today)
    return { date: today, decompose: 0, replan: 0 };
  return raw;
}

function saveAiCounts(counts: AiCounts): void {
  localStorage.setItem(scopedKey(KEY_AI_COUNTS), JSON.stringify(counts));
}

export function getAiUsage() {
  const counts = getAiCounts();
  const pro = isProUnlocked();
  return {
    decomposeUsed: counts.decompose,
    decomposeRemaining: pro
      ? Infinity
      : Math.max(0, FREE_DECOMPOSE_LIMIT - counts.decompose),
    replanUsed: counts.replan,
    replanRemaining: pro
      ? Infinity
      : Math.max(0, FREE_REPLAN_LIMIT - counts.replan),
  };
}

export function canDecompose(): boolean {
  if (isProUnlocked()) return true;
  return getAiCounts().decompose < FREE_DECOMPOSE_LIMIT;
}

export function canReplan(): boolean {
  if (isProUnlocked()) return true;
  return getAiCounts().replan < FREE_REPLAN_LIMIT;
}

export function incrementDecomposeCount(): void {
  const c = getAiCounts();
  c.decompose++;
  saveAiCounts(c);
}

export function incrementReplanCount(): void {
  const c = getAiCounts();
  c.replan++;
  saveAiCounts(c);
}

export function getProgress(plan: Plan): number {
  if (plan.tasks.length === 0) return 0;
  const done = plan.tasks.filter((t) => t.completed).length;
  return done / plan.tasks.length;
}

/** 仅统计大目标任务（排除临时任务灌水） */
export function getGoalOnlyProgress(ws?: Workspace): number {
  const w = ws ?? loadWorkspace();
  const tasks = w.plans.flatMap((p) => p.tasks);
  if (tasks.length === 0) return 0;
  return tasks.filter((t) => t.completed).length / tasks.length;
}

export function getOverallProgress(ws?: Workspace): number {
  return getGoalOnlyProgress(ws);
}

export type GoalMilestone = {
  planId: string;
  goal: string;
  progress: number;
  focusMinutes: number;
  daysToDeadline: number | null;
  reviewCycle: ReviewCycle;
  reviewDue: boolean;
  milestone25: boolean;
  milestone50: boolean;
  milestone100: boolean;
};

/** 按大目标分别计算里程碑（多目标互不影响） */
export function getGoalMilestones(ws?: Workspace): GoalMilestone[] {
  const w = ws ?? loadWorkspace();
  const today = todayStr();
  return w.plans
    .filter((p) => (p.status ?? "active") === "active")
    .map((p) => {
      const progress = getProgress(p);
      const focusMinutes = Math.round(
        p.tasks.reduce((s, t) => s + t.focusSeconds, 0) / 60
      );
      let daysToDeadline: number | null = null;
      const dl = new Date(p.deadline);
      if (!Number.isNaN(dl.getTime())) {
        const t0 = new Date(today);
        daysToDeadline = Math.ceil(
          (dl.getTime() - t0.getTime()) / (1000 * 60 * 60 * 24)
        );
      }
      const reviewCycle: ReviewCycle = p.reviewCycle ?? "weekly";
      const cycleDays = REVIEW_CYCLE_DAYS[reviewCycle];
      const lastDone = [...p.tasks]
        .filter((t) => t.completed)
        .map((t) => t.date)
        .sort()
        .at(-1);
      const anchor = lastDone ?? p.createdAt.slice(0, 10);
      let reviewDue = false;
      if (cycleDays > 0) {
        const a = new Date(anchor);
        const now = new Date(today);
        const gap = Math.floor(
          (now.getTime() - a.getTime()) / (1000 * 60 * 60 * 24)
        );
        reviewDue = gap >= cycleDays;
      }
      return {
        planId: p.id,
        goal: p.goal,
        progress,
        focusMinutes,
        daysToDeadline,
        reviewCycle,
        reviewDue,
        milestone25: progress >= 0.25,
        milestone50: progress >= 0.5,
        milestone100: progress >= 1,
      };
    });
}

/** 紧迫信号：今日未完成数 + 最近几天是否有完成记录 */
export function getUrgencySignal(ws?: Workspace, reviews?: ReviewLog[]): {
  todayLeft: number;
  daysSinceLastComplete: number | null;
  nearestDeadlineDays: number | null;
  nearestGoal: string | null;
} {
  const w = ws ?? loadWorkspace();
  const todayTasks = getTodayTasksFromWorkspace(w);
  const todayLeft = todayTasks.filter((t) => !t.completed).length;
  const revs = reviews ?? loadReviews();
  const completeDates = revs
    .filter((r) => r.completedCount > 0)
    .map((r) => r.date)
    .sort();
  let daysSinceLastComplete: number | null = null;
  const last = completeDates.at(-1);
  if (last) {
    const gap = Math.floor(
      (new Date(todayStr()).getTime() - new Date(last).getTime()) /
        (1000 * 60 * 60 * 24)
    );
    daysSinceLastComplete = Math.max(0, gap);
  } else if (w.plans.some((p) => p.tasks.length > 0)) {
    daysSinceLastComplete = null; // 从未完成过，由 UI 单独提示
  }

  let nearestDeadlineDays: number | null = null;
  let nearestGoal: string | null = null;
  for (const p of w.plans.filter((x) => (x.status ?? "active") === "active")) {
    const dl = new Date(p.deadline);
    if (Number.isNaN(dl.getTime())) continue;
    const days = Math.ceil(
      (dl.getTime() - new Date(todayStr()).getTime()) / (1000 * 60 * 60 * 24)
    );
    if (nearestDeadlineDays === null || days < nearestDeadlineDays) {
      nearestDeadlineDays = days;
      nearestGoal = p.goal;
    }
  }

  return {
    todayLeft,
    daysSinceLastComplete,
    nearestDeadlineDays,
    nearestGoal,
  };
}

const KEY_GLOBAL_DAILY_CAP = "stepup.globalDailyCap";
const DEFAULT_GLOBAL_DAILY_CAP = 180;

/** 多目标共享的全局每日总时长上限（分钟） */
export function getGlobalDailyCap(): number {
  const raw = Number(localStorage.getItem(scopedKey(KEY_GLOBAL_DAILY_CAP)));
  if (Number.isFinite(raw) && raw >= 30 && raw <= 600) return Math.round(raw);
  return DEFAULT_GLOBAL_DAILY_CAP;
}

export function setGlobalDailyCap(minutes: number): void {
  const value = Math.max(30, Math.min(600, Math.round(Number(minutes) || DEFAULT_GLOBAL_DAILY_CAP)));
  localStorage.setItem(scopedKey(KEY_GLOBAL_DAILY_CAP), String(value));
}

/**
 * 多目标每日预算分配：按截止紧迫度加权，总和不超过全局上限。
 */
export function allocateDailyBudgetsForActiveGoals(
  ws?: Workspace,
  globalCap?: number,
): Record<string, number> {
  const w = ws ?? loadWorkspace();
  const cap = globalCap ?? getGlobalDailyCap();
  const active = getActivePlans(w);
  if (active.length === 0) return {};
  if (active.length === 1) {
    return {
      [active[0].id]: Math.min(cap, active[0].dailyMinutes || cap),
    };
  }
  const today = todayStr();
  const weights = active.map((g) => {
    const days = Math.max(
      1,
      Math.ceil(
        (new Date(g.deadline).getTime() - new Date(today).getTime()) / 86_400_000,
      ),
    );
    const urgency = 1 / Math.sqrt(days);
    const asked = Math.max(30, Number(g.dailyMinutes) || 60);
    return { id: g.id, weight: urgency * asked, asked };
  });
  const totalWeight = weights.reduce((sum, item) => sum + item.weight, 0) || 1;
  const floor = Math.max(
    15,
    Math.min(30, Math.floor(cap / (active.length * 2))),
  );
  const result: Record<string, number> = {};
  for (const item of weights) {
    result[item.id] = Math.max(
      floor,
      Math.min(item.asked, Math.round((item.weight / totalWeight) * cap)),
    );
  }
  let assigned = Object.values(result).reduce((sum, n) => sum + n, 0);
  if (assigned > cap) {
    const scale = cap / assigned;
    for (const id of Object.keys(result)) {
      result[id] = Math.max(1, Math.round(result[id] * scale));
    }
    assigned = Object.values(result).reduce((sum, n) => sum + n, 0);
    while (assigned > cap) {
      const heaviest = Object.keys(result).sort(
        (a, b) => result[b] - result[a],
      )[0];
      if (!heaviest || result[heaviest] <= 1) break;
      result[heaviest] -= 1;
      assigned -= 1;
    }
  }
  return result;
}

/** 其他活跃目标在指定日期已占用的建议时长（不含 excludeGoalId） */
export function getOtherGoalsOccupiedMinutes(
  date: string,
  excludeGoalId?: string,
  ws?: Workspace,
): number {
  const w = ws ?? loadWorkspace();
  return getAllTasks(w)
    .filter(
      (task) =>
        task.date === date &&
        task.goalId &&
        task.goalId !== excludeGoalId &&
        !task.completed,
    )
    .reduce((sum, task) => sum + (Number(task.suggestedMinutes) || 0), 0);
}

export function getAdaptiveDecomposeContext(options?: {
  /** 仅统计该目标自身的完成率/积压；新建目标时不传 */
  goalId?: string;
  excludeGoalId?: string;
  excludeTaskIds?: Iterable<string>;
}): Pick<
  DecomposeRequest,
  | "completionRate"
  | "streakDays"
  | "unfinishedTasks"
  | "knowledgeKeyPoints"
  | "weakKnowledgePoints"
  | "adaptiveHint"
> {
  const excludedTaskIds = new Set(options?.excludeTaskIds ?? []);
  const scopeGoalId = options?.goalId;
  const ws = loadWorkspace();
  const plan = scopeGoalId
    ? ws.plans.find((item) => item.id === scopeGoalId)
    : undefined;

  // 目标隔离：有 goalId 时只用该目标任务完成率；否则用全局 reviews
  let completionRate: number | undefined;
  let rates: number[] = [];
  if (plan && plan.tasks.length > 0) {
    const dated = new Map<string, { done: number; total: number }>();
    for (const task of plan.tasks) {
      if (excludedTaskIds.has(task.id)) continue;
      const bucket = dated.get(task.date) ?? { done: 0, total: 0 };
      bucket.total += 1;
      if (task.completed) bucket.done += 1;
      dated.set(task.date, bucket);
    }
    rates = [...dated.values()]
      .filter((item) => item.total > 0)
      .slice(-3)
      .map((item) => Math.round((item.done / item.total) * 100));
    if (rates.length > 0) {
      completionRate = Math.round(
        rates.reduce((sum, rate) => sum + rate, 0) / rates.length,
      );
    }
  } else {
    const reviews = loadReviews()
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date));
    const recent = reviews.slice(-3);
    rates = recent
      .filter((review) => Number(review.totalCount) > 0)
      .map((review) =>
        Math.round((Number(review.completedCount) / Number(review.totalCount)) * 100),
      );
    completionRate =
      rates.length > 0
        ? Math.round(rates.reduce((sum, rate) => sum + rate, 0) / rates.length)
        : undefined;
  }

  const achievement = computeAchievement(ws, loadReviews());
  const pending = getPendingBacklog()
    .filter((item) => {
      if (excludedTaskIds.has(item.taskId)) return false;
      if (options?.excludeGoalId && item.goalId === options.excludeGoalId) {
        return false;
      }
      // 目标隔离：只带本目标积压，避免第二个目标被第一个污染
      if (scopeGoalId) return item.goalId === scopeGoalId;
      return true;
    })
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 8);
  const unfinishedTasks = pending.map((item) => item.title);

  const lastTwoLow =
    rates.length >= 2 && rates.slice(-2).every((rate) => Number(rate) < 50);
  const lastThreeHigh =
    rates.length >= 3 && rates.slice(-3).every((rate) => Number(rate) > 80);
  const adaptiveHint = lastTwoLow
    ? "该目标近期完成率较低，请减少每日任务量，增加复习时间"
    : lastThreeHigh
      ? "该目标执行状态良好，可适当增加难度"
      : undefined;

  return {
    completionRate,
    streakDays: achievement.streakDays,
    unfinishedTasks,
    knowledgeKeyPoints: [],
    weakKnowledgePoints: [],
    adaptiveHint,
  };
}

export const PRIORITY_RANK: Record<Priority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export function sortTasksByPriority(tasks: TaskItem[]): TaskItem[] {
  return [...tasks].sort(
    (a, b) =>
      (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9)
  );
}

/** @deprecated 单 plan 今日任务 */
export function getTodayTasks(plan: Plan): TaskItem[] {
  const today = todayStr();
  return plan.tasks.filter((t) => t.date === today);
}

export function getTomorrowTasks(plan: Plan): TaskItem[] {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const tomorrow = localDateStr(d);
  return plan.tasks.filter((t) => t.date === tomorrow && !t.completed);
}

export function computeAchievement(
  wsOrPlan: Workspace | Plan | null,
  reviews: ReviewLog[]
): Achievement {
  let totalFocusMinutes = 0;
  let progress = 0;

  if (wsOrPlan && "plans" in wsOrPlan) {
    // 专注时长含临时任务；里程碑进度只计大目标，避免灌水
    const tasks = getAllTasks(wsOrPlan);
    totalFocusMinutes = Math.round(
      tasks.reduce((sum, t) => sum + t.focusSeconds, 0) / 60
    );
    progress = getGoalOnlyProgress(wsOrPlan);
  } else if (wsOrPlan) {
    totalFocusMinutes = Math.round(
      wsOrPlan.tasks.reduce((sum, t) => sum + t.focusSeconds, 0) / 60
    );
    progress = getProgress(wsOrPlan);
  }

  // streak 只计 completedCount > 0 的日期（纯 skip 不计入）
  const actionDates = new Set(
    reviews
      .filter((r) => r.completedCount > 0)
      .map((r) => r.date)
  );

  let streakDays = 0;
  if (actionDates.size > 0) {
    const d = new Date();
    if (!actionDates.has(todayStr())) {
      d.setDate(d.getDate() - 1);
    }
    while (actionDates.has(localDateStr(d))) {
      streakDays += 1;
      d.setDate(d.getDate() - 1);
    }
  }

  return {
    totalFocusMinutes,
    streakDays,
    milestone25: progress >= 0.25,
    milestone50: progress >= 0.5,
    milestone100: progress >= 1,
  };
}

export function getTimerSeconds(taskId: string): number {
  try {
    const all = JSON.parse(
      localStorage.getItem(scopedKey("stepup.timer")) || "{}"
    ) as Record<
      string,
      { accumulatedSeconds?: number; startedAt?: number | null; state?: string }
    >;
    const p = all[taskId];
    if (!p) return 0;
    let sec = p.accumulatedSeconds ?? 0;
    if (p.state === "running" && p.startedAt) {
      sec += Math.floor((Date.now() - p.startedAt) / 1000);
    }
    return Math.max(0, sec);
  } catch {
    return 0;
  }
}

export function syncFocusFromTimers(ws?: Workspace): Workspace {
  const base = ws ?? loadWorkspace();
  const w: Workspace = {
    activePlanId: base.activePlanId,
    plans: base.plans.map((p) => ({
      ...p,
      tasks: p.tasks.map((t) => ({
        ...t,
        focusSeconds: Math.max(t.focusSeconds, getTimerSeconds(t.id)),
      })),
    })),
    adhocTasks: base.adhocTasks.map((t) => ({
      ...t,
      focusSeconds: Math.max(t.focusSeconds, getTimerSeconds(t.id)),
    })),
  };
  saveWorkspace(w);
  return w;
}

/** 兼容旧 syncFocusFromTimers(plan) 签名：若传入 Plan，仍更新 workspace 中该 plan */
export function syncFocusFromTimersPlan(plan: Plan): Plan {
  const ws = syncFocusFromTimers();
  return ws.plans.find((p) => p.id === plan.id) ?? plan;
}

export function buildEncouragement(
  completedCount: number,
  totalCount: number,
  focusMinutes: number,
  streakDays: number
): string {
  if (totalCount === 0) return "先去规划今天的任务吧。";
  if (completedCount === totalCount && totalCount > 0) {
    if (streakDays >= 7) {
      return `今日 ${completedCount} 项全部完成，专注 ${focusMinutes} 分钟。你已连续行动 ${streakDays} 天，节奏很稳。`;
    }
    return `今日 ${completedCount} 项全部完成，专注 ${focusMinutes} 分钟。把大目标拆成今天做得到的小事，你做到了。`;
  }
  const rate = Math.round((completedCount / totalCount) * 100);
  if (rate >= 60) {
    return `今天完成了 ${completedCount}/${totalCount}（${rate}%），专注 ${focusMinutes} 分钟。未完成的已放进待办池，明天由你决定是否继续。`;
  }
  return `今天完成了 ${completedCount}/${totalCount}。没做完没关系，未完成已记录，明天你可以选择加入或先放着。`;
}
