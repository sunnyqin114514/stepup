import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { decomposePlan, replanPlan } from "../services/planApi";
import {
  allocateDailyBudgetsForActiveGoals,
  canAddActiveGoal,
  canDecompose,
  canReplan,
  clearPlanRelatedLocalState,
  FREE_DECOMPOSE_LIMIT,
  FREE_REPLAN_LIMIT,
  getAdaptiveDecomposeContext,
  getActivePlans,
  getAiUsage,
  getGlobalDailyCap,
  getOtherGoalsOccupiedMinutes,
  incrementDecomposeCount,
  incrementReplanCount,
  isProUnlocked,
  loadWorkspace,
  removePlan,
  setActivePlanId,
  setGlobalDailyCap,
  setPlanStatus,
  sortTasksByPriority,
  todayStr,
  uid,
  upsertPlan,
} from "../lib/storage";
import { isWeekend, localDateStr } from "../lib/scheduleDates";
import type { Plan, ReviewCycle, TaskItem, Workspace } from "../types/plan";
import {
  FREE_ACTIVE_GOAL_LIMIT,
  REVIEW_CYCLE_LABELS,
} from "../types/plan";
import TaskCard from "../components/TaskCard";
import PlanCalendarBrief, {
  monthCursorFromDate,
} from "../components/PlanCalendarBrief";

function groupByDate(tasks: TaskItem[]): Record<string, TaskItem[]> {
  const map: Record<string, TaskItem[]> = {};
  for (const t of tasks) {
    (map[t.date] ??= []).push(t);
  }
  for (const date of Object.keys(map)) {
    map[date] = sortTasksByPriority(map[date]);
  }
  return map;
}

export default function PlannerPage() {
  const navigate = useNavigate();
  const [ws, setWs] = useState<Workspace>(() => loadWorkspace());
  const activePlan =
    ws.plans.find((p) => p.id === ws.activePlanId) ?? ws.plans[0] ?? null;

  const [goal, setGoal] = useState(activePlan?.goal ?? "");
  const [deadline, setDeadline] = useState(activePlan?.deadline ?? "");
  const [dailyMinutes, setDailyMinutes] = useState(
    activePlan?.dailyMinutes ?? 120
  );
  const [workdays, setWorkdays] = useState<string[]>(
    activePlan?.workdays ?? ["weekday", "weekend"]
  );
  const [reviewCycle, setReviewCycle] = useState<ReviewCycle>(
    activePlan?.reviewCycle ?? "weekly"
  );
  const [foundation, setFoundation] = useState(activePlan?.foundation ?? "");
  const [weakness, setWeakness] = useState(activePlan?.weakness ?? "");
  const [loading, setLoading] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mockNotice, setMockNotice] = useState(false);
  const [adjustNotice, setAdjustNotice] = useState<string | null>(null);
  const [adjustNote, setAdjustNote] = useState("");
  const [creatingNew, setCreatingNew] = useState(false);
  const [globalDailyCap, setGlobalDailyCapState] = useState(() => getGlobalDailyCap());
  /** null = 查看全部时间线；有值则只展示该日任务 */
  const [selectedCalDate, setSelectedCalDate] = useState<string | null>(null);
  const [calMonth, setCalMonth] = useState(() =>
    monthCursorFromDate(localDateStr()),
  );

  const resetCalendarFocus = (nextPlan: Plan | null) => {
    const today = localDateStr();
    setCalMonth(monthCursorFromDate(today));
    if (!nextPlan) {
      setSelectedCalDate(null);
      return;
    }
    const hasToday = nextPlan.tasks.some((t) => t.date === today);
    setSelectedCalDate(hasToday ? today : null);
  };

  // AI 拆解时的动态文案轮播：让用户感知"系统在动"，缓解等待焦虑
  const LOADING_STEPS = [
    "AI 拆解中…",
    "正在分析目标…",
    "拆分每日任务…",
    "校验时间预算…",
    "生成执行步骤…",
  ];
  const [loadingStep, setLoadingStep] = useState(0);
  useEffect(() => {
    if (!loading) {
      setLoadingStep(0);
      return;
    }
    const timer = setInterval(() => {
      setLoadingStep((s) => Math.min(s + 1, LOADING_STEPS.length - 1));
    }, 2200);
    return () => clearInterval(timer);
  }, [loading]);

  const plan = creatingNew ? null : activePlan;

  // 切换目标时重置日历焦点（不在选日时触发）
  useEffect(() => {
    if (creatingNew) {
      resetCalendarFocus(null);
      return;
    }
    resetCalendarFocus(activePlan);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅随目标切换重置
  }, [ws.activePlanId, creatingNew]);

  const grouped = useMemo(
    () => (plan ? groupByDate(plan.tasks) : {}),
    [plan]
  );
  const sortedDates = useMemo(() => Object.keys(grouped).sort(), [grouped]);

  // 时间线：优先使用 AI/算法生成的 schedule；仅把明确休息日标为 rest
  const timelineEntries = useMemo(() => {
    if (!plan) return [] as { date: string; type: "task" | "rest"; weekend: boolean }[];
    const restSet = new Set(plan.schedule?.restDates ?? []);
    const taskDates = new Set(sortedDates);
    const scheduleDates = [
      ...new Set([
        ...(plan.schedule?.workDates ?? []),
        ...(plan.schedule?.restDates ?? []),
        ...sortedDates,
      ]),
    ].sort();

    if (scheduleDates.length === 0) return [];

    const taskList = [...taskDates].sort();
    const firstTask = taskList[0];
    const lastTask = taskList[taskList.length - 1];

    return scheduleDates
      .map((date) => ({
        date,
        type: (restSet.has(date) && !taskDates.has(date) ? "rest" : "task") as
          | "task"
          | "rest",
        weekend: isWeekend(date),
      }))
      .filter((entry) => {
        if (taskDates.has(entry.date)) return true;
        // 休息日只显示在首末任务之间，避免 8/1 休息后直接跳到 8/21 任务
        if (entry.type === "rest" && firstTask && lastTask) {
          return entry.date >= firstTask && entry.date <= lastTask;
        }
        return false;
      });
  }, [plan, sortedDates]);
  const activeCount = getActivePlans(ws).length;
  const pro = isProUnlocked();

  const selectPlan = (planId: string) => {
    setCreatingNew(false);
    const next = setActivePlanId(planId);
    setWs(next);
    const p = next.plans.find((x) => x.id === planId) ?? null;
    if (p) {
      setGoal(p.goal);
      setDeadline(p.deadline);
      setDailyMinutes(p.dailyMinutes);
      setWorkdays(p.workdays);
      setReviewCycle(p.reviewCycle ?? "weekly");
      setFoundation(p.foundation ?? "");
      setWeakness(p.weakness ?? "");
    }
    resetCalendarFocus(p);
  };

  const startNewGoal = () => {
    if (!canAddActiveGoal(ws)) {
      setError(
        `免费版最多 ${FREE_ACTIVE_GOAL_LIMIT} 个进行中目标。请升级 Pro，或先暂停/完成现有目标。`
      );
      return;
    }
    setCreatingNew(true);
    setGoal("");
    setDeadline("");
    setDailyMinutes(120);
    setWorkdays(["weekday", "weekend"]);
    setReviewCycle("weekly");
    setFoundation("");
    setWeakness("");
    setError(null);
    setMockNotice(false);
    resetCalendarFocus(null);
  };

  const toggleWorkday = (w: string) => {
    setWorkdays((prev) => {
      if (prev.includes(w)) {
        const next = prev.filter((x) => x !== w);
        // 至少保留一个可执行日类型，避免排期为空
        return next.length === 0 ? prev : next;
      }
      return [...prev, w];
    });
  };

  const handleDecompose = async () => {
    setError(null);
    if (!goal.trim()) {
      setError("请输入你的大目标");
      return;
    }
    if (!deadline) {
      setError("请选择截止日期");
      return;
    }
    if (deadline <= todayStr()) {
      setError("截止日期必须晚于今天");
      return;
    }

    // 新建时检查配额
    if (creatingNew && !canAddActiveGoal(ws)) {
      setError(
        `免费版最多 ${FREE_ACTIVE_GOAL_LIMIT} 个进行中目标，请升级 Pro。`
      );
      return;
    }

    // AI 拆解次数检查（免费版每天 3 次）
    if (!canDecompose()) {
      setError(
        `今日 AI 拆解次数已用完（免费版每天 ${FREE_DECOMPOSE_LIMIT} 次）。升级 Pro 可无限使用。`
      );
      return;
    }

    setLoading(true);
    try {
      const planId = creatingNew || !plan ? uid() : plan.id;
      const oldTaskIds = plan?.tasks.map((task) => task.id) ?? [];
      const cap = getGlobalDailyCap();
      // 预估分配：把即将新建/更新的目标也算进活跃列表
      const previewWs: Workspace = {
        ...ws,
        plans: creatingNew
          ? [
              ...ws.plans,
              {
                id: planId,
                goal: goal.trim(),
                deadline,
                dailyMinutes,
                workdays: workdays as Plan["workdays"],
                createdAt: new Date().toISOString(),
                tasks: [],
                status: "active",
              },
            ]
          : ws.plans.map((p) =>
              p.id === planId ? { ...p, dailyMinutes, deadline, status: "active" } : p,
            ),
      };
      const budgets = allocateDailyBudgetsForActiveGoals(previewWs, cap);
      const allocated = budgets[planId] ?? Math.min(cap, dailyMinutes);

      const res = await decomposePlan({
        goal: goal.trim(),
        deadline,
        dailyMinutes,
        workdays,
        foundation: foundation.trim(),
        weakness: weakness.trim(),
        globalDailyCap: cap,
        allocatedDailyMinutes: allocated,
        ...getAdaptiveDecomposeContext({
          goalId: creatingNew ? undefined : planId,
          excludeGoalId: creatingNew ? undefined : planId,
          excludeTaskIds: creatingNew ? undefined : oldTaskIds,
        }),
      });

      const tasks: TaskItem[] = res.tasks.map((t) => ({
        ...t,
        id: uid(),
        completed: false,
        focusSeconds: 0,
        source: "goal" as const,
        goalId: planId,
      }));

      // 重新拆解：整表替换（含已完成）。旧逻辑会保留已打勾任务，
      // 导致「摸底诊断」等旧卡在多次解析后仍出现在学习日。
      const newPlan: Plan = {
        id: planId,
        goal: goal.trim(),
        deadline,
        dailyMinutes,
        workdays: workdays as Plan["workdays"],
        reviewCycle,
        createdAt: creatingNew || !plan ? new Date().toISOString() : plan.createdAt,
        tasks,
        status: "active",
        foundation: foundation.trim(),
        weakness: weakness.trim(),
        schedule: res.schedule ?? {
          workDates: [...new Set(tasks.map((t) => t.date))].sort(),
          restDates: [],
          dailyBudgetMinutes: res.allocatedDailyMinutes ?? allocated,
        },
      };

      if (!creatingNew && plan) {
        clearPlanRelatedLocalState(plan.id, oldTaskIds);
      }
      const next = upsertPlan(newPlan);
      setWs(next);
      setCreatingNew(false);
      // 与后端一致：仅真实 AI 成功计次，演示/兜底不烧本地免费额度
      if (!res.mock) {
        incrementDecomposeCount();
      }
      setMockNotice(Boolean(res.mock));
      resetCalendarFocus(newPlan);
      const todayCount = tasks.filter((t) => t.date === todayStr()).length;
      // 拆解成功 → 跳转学习日（高动机时刻落地）
      navigate("/schedule", {
        state: {
          decomposeSuccess: true,
          taskCount: todayCount,
          totalTaskCount: tasks.length,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "AI 调用失败";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleAdjust = async () => {
    if (!plan) return;
    setError(null);
    const instruction = adjustNote.trim();
    // 空指令走本地重排，不占 AI 重排次数；有具体指令才检查额度
    const needsAiQuota =
      Boolean(instruction) &&
      instruction !== "用户主动请求调整日程" &&
      instruction !== "无（按默认规则重排）";
    if (needsAiQuota && !canReplan()) {
      setError(
        `今日 AI 重排次数已用完（免费版每天 ${FREE_REPLAN_LIMIT} 次）。升级 Pro 可无限使用。`
      );
      return;
    }
    setAdjusting(true);
    setError(null);
    setAdjustNotice(null);
    try {
      const cap = getGlobalDailyCap();
      const budgets = allocateDailyBudgetsForActiveGoals(
        {
          ...ws,
          plans: ws.plans.map((p) =>
            p.id === plan.id ? { ...p, dailyMinutes } : p,
          ),
        },
        cap,
      );
      const allocated = budgets[plan.id] ?? Math.min(cap, dailyMinutes);
      const unfinished = plan.tasks.filter((t) => !t.completed);
      const done = plan.tasks.filter((t) => t.completed);
      const goalCompletionRate =
        plan.tasks.length > 0
          ? Math.round((done.length / plan.tasks.length) * 100)
          : undefined;

      const res = await replanPlan({
        plan: { ...plan, dailyMinutes },
        // 空指令 = 只重排日期；有指令才改写任务内容/步骤
        difficulty: instruction,
        tomorrowMinutes: allocated,
        globalDailyCap: cap,
        allocatedDailyMinutes: allocated,
        otherGoalsOccupiedMinutes: getOtherGoalsOccupiedMinutes(
          todayStr(),
          plan.id,
          ws,
        ),
        unfinishedSummary: unfinished.map((t) => t.title).slice(0, 12),
        goalCompletionRate,
      });
      const completedTasks = plan.tasks.filter((t) => t.completed);
      const newTasks: TaskItem[] = res.tasks.map((t) => ({
        ...t,
        id: uid(),
        completed: false,
        focusSeconds: 0,
        source: "goal" as const,
        goalId: plan.id,
      }));
      const nextPlan: Plan = {
        ...plan,
        dailyMinutes,
        reviewCycle,
        foundation: foundation.trim(),
        weakness: weakness.trim(),
        tasks: [...completedTasks, ...newTasks],
        schedule: res.schedule ?? plan.schedule,
      };
      setWs(upsertPlan(nextPlan));
      if (needsAiQuota && !res.mock) {
        incrementReplanCount();
      }
      // 调整日程不再复用「演示模式」黄条；算法兜底也会真实改休息日
      setMockNotice(false);
      const restN = res.schedule?.restDates?.length ?? 0;
      const tip =
        res.suggestion?.trim() ||
        `已更新排期（休息日 ${restN} 天）`;
      setAdjustNotice(
        res.mock
          ? `${tip}（AI 超时，已用本地算法按指令完成，休息日与节奏已生效）`
          : tip,
      );
      setAdjustNote("");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "调整失败";
      setError(msg);
    } finally {
      setAdjusting(false);
    }
  };

  const handleToggle = (id: string) => {
    if (!plan) return;
    const tasks = plan.tasks.map((t) =>
      t.id === id ? { ...t, completed: !t.completed } : t
    );
    setWs(upsertPlan({ ...plan, tasks }));
  };

  const handleEdit = (id: string, patch: Partial<TaskItem>) => {
    if (!plan) return;
    const tasks = plan.tasks.map((t) =>
      t.id === id ? { ...t, ...patch } : t
    );
    setWs(upsertPlan({ ...plan, tasks }));
  };

  const handlePause = () => {
    if (!plan) return;
    setWs(setPlanStatus(plan.id, "paused"));
  };

  const handleResume = (planId: string) => {
    if (!canAddActiveGoal(ws) && !pro) {
      const target = ws.plans.find((p) => p.id === planId);
      if (target && (target.status ?? "active") !== "active") {
        setError(
          `免费版最多 ${FREE_ACTIVE_GOAL_LIMIT} 个进行中目标。请先暂停其他目标，或升级 Pro。`
        );
        return;
      }
    }
    // 若当前激活数已满且目标不是 active，拦截
    const target = ws.plans.find((p) => p.id === planId);
    if (
      target &&
      (target.status ?? "active") !== "active" &&
      !canAddActiveGoal(ws)
    ) {
      setError(
        `免费版最多 ${FREE_ACTIVE_GOAL_LIMIT} 个进行中目标。请升级 Pro。`
      );
      return;
    }
    setWs(setPlanStatus(planId, "active"));
    selectPlan(planId);
  };

  const handleDelete = () => {
    if (!plan) return;
    if (!confirm(`确定删除目标「${plan.goal}」？任务将一并删除。`)) return;
    const next = removePlan(plan.id);
    setWs(next);
    const p = next.plans.find((x) => x.id === next.activePlanId);
    if (p) {
      setGoal(p.goal);
      setDeadline(p.deadline);
      setDailyMinutes(p.dailyMinutes);
      setWorkdays(p.workdays);
      setCreatingNew(false);
    } else {
      setCreatingNew(true);
      setGoal("");
      setDeadline("");
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">目标规划</h1>
          <p className="text-sm text-slate-500 mt-1">
            管理多个大目标与长期排期。日常执行去「学习日」，也可在那里加临时任务。
          </p>
        </div>
        <Link to="/schedule" className="btn-primary shrink-0">
          进入学习日
        </Link>
      </div>

      {/* AI 用量进度 */}
      {pro ? (
        <div className="card p-3 mb-4 flex items-center gap-2 text-sm text-amber-700 bg-amber-50/50">
          <span>✨</span>
          <span>Pro 会员 · 无限 AI 拆解/重排</span>
        </div>
      ) : (
        (() => {
          const usage = getAiUsage();
          return (
            <div className="card p-3 mb-4 flex items-center gap-3">
              <span className="text-xs text-slate-500 shrink-0">
                今日 AI 拆解
              </span>
              <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                <div
                  className="h-full bg-brand-500 transition-all"
                  style={{
                    width: `${Math.min(100, (usage.decomposeUsed / FREE_DECOMPOSE_LIMIT) * 100)}%`,
                  }}
                />
              </div>
              <span className="text-xs font-medium text-slate-600 shrink-0">
                {usage.decomposeUsed}/{FREE_DECOMPOSE_LIMIT} 已用
              </span>
            </div>
          );
        })()
      )}

      {/* 多目标列表 */}
      <div className="card p-4 mb-6">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="font-semibold text-slate-900">我的大目标</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              进行中 {activeCount} 个
              {!pro && ` · 免费版上限 ${FREE_ACTIVE_GOAL_LIMIT} 个`}
              {pro && " · Pro 不限数量"}
            </p>
          </div>
          <button className="btn-ghost text-sm py-1.5" onClick={startNewGoal}>
            + 新建目标
          </button>
        </div>

        {ws.plans.length === 0 && !creatingNew ? (
          <p className="text-sm text-slate-500 py-2">
            还没有大目标。点击「新建目标」开始 AI 拆解。
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {ws.plans.map((p) => {
              const active = !creatingNew && plan?.id === p.id;
              const paused = (p.status ?? "active") === "paused";
              return (
                <button
                  key={p.id}
                  onClick={() =>
                    paused ? handleResume(p.id) : selectPlan(p.id)
                  }
                  className={`px-3 py-2 rounded-xl text-sm border text-left transition max-w-[220px] ${
                    active
                      ? "bg-brand-50 border-brand-300 text-brand-700"
                      : paused
                      ? "bg-slate-50 border-slate-200 text-slate-400"
                      : "bg-white border-slate-200 text-slate-700 hover:border-brand-200"
                  }`}
                >
                  <div className="font-medium truncate">{p.goal}</div>
                  <div className="text-[10px] mt-0.5">
                    {paused ? "已暂停 · 点击恢复" : `截止 ${p.deadline}`}
                  </div>
                </button>
              );
            })}
            {creatingNew && (
              <span className="px-3 py-2 rounded-xl text-sm border border-dashed border-brand-300 bg-brand-50/50 text-brand-600">
                新建中…
              </span>
            )}
          </div>
        )}

        {!pro && activeCount >= FREE_ACTIVE_GOAL_LIMIT && (
          <p className="text-xs text-amber-600 mt-3">
            已达免费版上限。
            <Link to="/membership" className="underline ml-1">
              升级 Pro
            </Link>
            可同时推进多个大目标。
          </p>
        )}
      </div>

      <div className="card p-5 mb-6">
        <label className="block text-sm font-medium text-slate-700 mb-1">
          {creatingNew ? "新增大目标" : "当前大目标"}
        </label>
        <input
          className="input-field mb-4"
          placeholder="如：上线个人作品集 / 竞赛拿奖 / 3 个月转岗准备 / 学完 Python"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
        />

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              截止日期
            </label>
            <input
              type="date"
              className="input-field"
              value={deadline}
              min={todayStr()}
              onChange={(e) => setDeadline(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              本目标每日时长（分钟）
            </label>
            <input
              type="number"
              min={15}
              max={600}
              className="input-field"
              value={dailyMinutes}
              onChange={(e) =>
                setDailyMinutes(Number(e.target.value) || 60)
              }
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              全局每日总上限（分钟）
            </label>
            <input
              type="number"
              min={30}
              max={600}
              className="input-field"
              value={globalDailyCap}
              onChange={(e) => {
                const value = Number(e.target.value) || 180;
                setGlobalDailyCapState(value);
                setGlobalDailyCap(value);
              }}
            />
            <p className="text-[11px] text-slate-400 mt-1">
              多目标共享；系统按截止紧迫度自动分配
            </p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">自身基础</label>
            <textarea
              className="input-field min-h-[88px]"
              placeholder="如：已完成入门课程，能独立做基础练习"
              value={foundation}
              onChange={(event) => setFoundation(event.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">薄弱领域</label>
            <textarea
              className="input-field min-h-[88px]"
              placeholder="如：概念会但迁移困难；表达结构不清晰"
              value={weakness}
              onChange={(event) => setWeakness(event.target.value)}
            />
          </div>
        </div>

        <div className="mt-4">
          <label className="block text-sm font-medium text-slate-700 mb-2">
            可执行日
          </label>
          <div className="flex gap-2">
            {[
              { v: "weekday", l: "工作日" },
              { v: "weekend", l: "周末" },
            ].map((w) => (
              <button
                key={w.v}
                onClick={() => toggleWorkday(w.v)}
                className={`px-4 py-1.5 rounded-lg text-sm border transition ${
                  workdays.includes(w.v)
                    ? "bg-brand-50 border-brand-300 text-brand-600"
                    : "bg-white border-slate-200 text-slate-600"
                }`}
              >
                {w.l}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <label className="block text-sm font-medium text-slate-700 mb-2">
            循环复盘周期
          </label>
          <p className="text-xs text-slate-400 mb-2">
            到期会在复盘页提醒你回头看这个目标（与任务优先级标签独立）。
          </p>
          <div className="flex flex-wrap gap-2">
            {(
              Object.keys(REVIEW_CYCLE_LABELS) as ReviewCycle[]
            ).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setReviewCycle(key);
                  if (plan && !creatingNew) {
                    setWs(upsertPlan({ ...plan, reviewCycle: key }));
                  }
                }}
                className={`px-3 py-1.5 rounded-lg text-sm border transition ${
                  reviewCycle === key
                    ? "bg-brand-50 border-brand-300 text-brand-600"
                    : "bg-white border-slate-200 text-slate-600"
                }`}
              >
                {REVIEW_CYCLE_LABELS[key]}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-lg bg-rose-50 text-rose-600 text-sm px-3 py-2">
            {error}
          </div>
        )}

        {mockNotice && (
          <div className="mt-4 rounded-lg bg-amber-50 text-amber-700 text-sm px-3 py-2">
            演示模式：当前为示例/兜底数据。配置 DeepSeek key 后将使用真实 AI。
          </div>
        )}
        {adjustNotice && (
          <div className="mt-4 rounded-lg bg-emerald-50 text-emerald-800 text-sm px-3 py-2">
            {adjustNotice}
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            className="btn-primary"
            disabled={loading}
            onClick={handleDecompose}
          >
            {loading
              ? LOADING_STEPS[loadingStep]
              : creatingNew || !plan
              ? "AI 拆解"
              : "重新拆解"}
          </button>
          {plan && !creatingNew && (
            <span className="text-xs text-stone-400">
              重新拆解会清空本目标全部旧任务（含已打勾）
            </span>
          )}
          <Link to="/schedule" className="btn-ghost">
            进入学习日
          </Link>
          {plan && !creatingNew && (
            <>
              <button className="btn-ghost" onClick={handlePause}>
                暂停此目标
              </button>
              <button
                className="text-sm text-rose-500 hover:underline"
                onClick={handleDelete}
              >
                删除
              </button>
            </>
          )}
          {creatingNew && ws.plans.length > 0 && (
            <button
              className="btn-ghost"
              onClick={() => {
                setCreatingNew(false);
                if (activePlan) selectPlan(activePlan.id);
              }}
            >
              取消新建
            </button>
          )}
        </div>
      </div>

      {plan && !creatingNew && (
        <>
          <div className="card p-5 mb-6">
            <h2 className="font-semibold text-slate-900 mb-1">调整日程</h2>
            <p className="text-xs text-slate-500 mb-3">
              填写具体指令会改写任务内容与步骤；留空则只重排日期节奏，执行细节保持不变。
            </p>
            <textarea
              className="input-field min-h-[64px] mb-3"
              placeholder="例如：节奏放慢并增加休息 / 把数学提前并加强错题订正"
              value={adjustNote}
              onChange={(e) => setAdjustNote(e.target.value)}
            />
            <button
              className="btn-ghost"
              disabled={adjusting}
              onClick={handleAdjust}
            >
              {adjusting ? "调整中…" : "AI 调整日程"}
            </button>
          </div>

          <PlanCalendarBrief
            tasks={plan.tasks}
            restDates={plan.schedule?.restDates ?? []}
            selectedDate={selectedCalDate}
            monthCursor={calMonth}
            onSelectDate={(date) => {
              setSelectedCalDate(date);
              setCalMonth(monthCursorFromDate(date));
            }}
            onMonthChange={setCalMonth}
            onShowAll={() => setSelectedCalDate(null)}
          />

          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-slate-900">
              {plan.goal}
            </h2>
            <span className="text-xs text-slate-400">
              {selectedCalDate
                ? `${selectedCalDate} · ${(grouped[selectedCalDate] ?? []).length} 个任务`
                : `${plan.tasks.length} 个任务 · 全部`}
            </span>
          </div>

          {sortedDates.length === 0 && (
            <div className="text-sm text-slate-500 py-8 text-center">
              暂无任务
            </div>
          )}

          <div className="space-y-6">
            {selectedCalDate ? (
              (grouped[selectedCalDate] ?? []).length > 0 ? (
                <div>
                  <div className="text-xs font-medium text-slate-500 mb-2 px-1">
                    {selectedCalDate}
                    {isWeekend(selectedCalDate) && " · 周末"}
                  </div>
                  <div className="space-y-2">
                    {(grouped[selectedCalDate] ?? []).map((t) => (
                      <TaskCard
                        key={t.id}
                        task={t}
                        goalLabel={plan.goal}
                        onToggleComplete={handleToggle}
                        onEdit={handleEdit}
                      />
                    ))}
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/50 px-4 py-6 text-sm text-slate-500 text-center">
                  {plan.schedule?.restDates?.includes(selectedCalDate)
                    ? `${selectedCalDate} · 休息日，暂无任务`
                    : `${selectedCalDate} · 这天没有安排任务`}
                  <button
                    type="button"
                    className="block mx-auto mt-2 text-xs text-[#c0451f] hover:underline"
                    onClick={() => setSelectedCalDate(null)}
                  >
                    查看全部任务
                  </button>
                </div>
              )
            ) : (
              timelineEntries.map((entry) =>
                entry.type === "task" ? (
                  <div key={entry.date}>
                    <div className="text-xs font-medium text-slate-500 mb-2 px-1">
                      {entry.date}
                      {entry.weekend && " · 周末"}
                    </div>
                    <div className="space-y-2">
                      {grouped[entry.date].map((t) => (
                        <TaskCard
                          key={t.id}
                          task={t}
                          goalLabel={plan.goal}
                          onToggleComplete={handleToggle}
                          onEdit={handleEdit}
                        />
                      ))}
                    </div>
                  </div>
                ) : (
                  <div
                    key={entry.date}
                    className="rounded-xl border border-dashed border-slate-200 bg-slate-50/50 px-4 py-3 text-sm text-slate-400 flex items-center gap-2"
                  >
                    <span className="text-base">
                      {entry.weekend ? "☕" : "📅"}
                    </span>
                    <span>
                      {entry.date} ·{" "}
                      {entry.weekend ? "周末休息日" : "AI 安排休息日"}
                    </span>
                  </div>
                ),
              )
            )}
          </div>
        </>
      )}
    </div>
  );
}
