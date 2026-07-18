import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  computeAchievement,
  getGoalMilestones,
  getOverallProgress,
  getPendingBacklog,
  getTodayTasksFromWorkspace,
  getTomorrowTasksFromWorkspace,
  getUrgencySignal,
  loadReviews,
  loadTaskAiReviews,
  loadWorkspace,
  todayStr,
} from "../lib/storage";
import {
  REVIEW_CYCLE_LABELS,
  SKIP_REASON_LABELS,
  type ReviewLog,
} from "../types/plan";
import type { StructuredReviewReport } from "../types/plan";
import { listReviewReports } from "../services/planApi";

export default function ProgressPage() {
  const location = useLocation();
  const ws = useMemo(() => loadWorkspace(), [location.key]);
  const reviews = useMemo(() => loadReviews(), [location.key]);
  const taskAiReviews = useMemo(
    () => loadTaskAiReviews(),
    [location.key]
  );
  const backlog = useMemo(() => getPendingBacklog(), [location.key]);
  const today = todayStr();
  const highlightTaskId =
    (location.state as { taskId?: string } | null)?.taskId ?? null;
  const [serverReports, setServerReports] = useState<StructuredReviewReport[]>([]);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [goalFilter, setGoalFilter] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);

  const loadServerReports = async () => {
    setServerError(null);
    try {
      const result = await listReviewReports({
        from: fromDate || undefined,
        to: toDate || undefined,
        goalId: goalFilter || undefined,
      });
      setServerReports(result.reports ?? []);
    } catch (error) {
      console.error("结构化复盘报告加载失败，继续展示本地每日复盘", error);
      setServerError(error instanceof Error ? error.message : "结构化复盘加载失败");
    }
  };

  useEffect(() => {
    void loadServerReports();
  }, [location.key]);

  const accuracyPoints = serverReports
    .filter((report) => report.accuracy !== null && report.accuracy !== undefined)
    .slice()
    .reverse()
    .slice(-12);
  const weaknessCounts = serverReports.reduce<Record<string, number>>((counts, report) => {
    for (const weakness of report.weaknesses ?? []) counts[weakness] = (counts[weakness] ?? 0) + 1;
    return counts;
  }, {});
  const topWeaknesses = Object.entries(weaknessCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);

  const achievement = useMemo(
    () => computeAchievement(ws, reviews),
    [ws, reviews]
  );
  const goalMilestones = useMemo(() => getGoalMilestones(ws), [ws]);
  const urgency = useMemo(
    () => getUrgencySignal(ws, reviews),
    [ws, reviews]
  );

  const todayReview: ReviewLog | null = useMemo(() => {
    const list = reviews.filter((r) => r.date === today);
    return list.at(-1) ?? null;
  }, [reviews, today]);

  const todayTasks = getTodayTasksFromWorkspace(ws);
  const tomorrowTasks = getTomorrowTasksFromWorkspace(ws);
  const progress = getOverallProgress(ws);
  const hasData =
    ws.plans.length > 0 ||
    ws.adhocTasks.length > 0 ||
    reviews.length > 0 ||
    taskAiReviews.length > 0;

  if (!hasData) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-16 text-center">
        <div className="text-slate-500 mb-4">还没有学习记录</div>
        <Link to="/schedule" className="btn-primary">
          进入学习日
        </Link>
      </div>
    );
  }

  const completedToday =
    todayReview?.completedCount ??
    todayTasks.filter((t) => t.completed).length;
  const totalToday = todayReview?.totalCount ?? todayTasks.length;
  const focusMinutes =
    todayReview?.focusMinutes ??
    Math.round(todayTasks.reduce((s, t) => s + t.focusSeconds, 0) / 60);
  const rate =
    totalToday > 0 ? Math.round((completedToday / totalToday) * 100) : 0;
  const activeGoals = ws.plans.filter(
    (p) => (p.status ?? "active") === "active"
  );

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">每日复盘</h1>
          <p className="text-sm text-slate-500 mt-1">
            总结今天做得怎么样。未完成在池子里，明天由你选择是否加入学习日。
          </p>
        </div>
        <Link to="/schedule" className="btn-primary shrink-0">
          查看学习日
        </Link>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard
          label="今日完成"
          value={`${completedToday}/${totalToday}`}
          accent="text-brand-600"
        />
        <StatCard
          label="今日专注"
          value={`${focusMinutes} 分钟`}
          accent="text-emerald-600"
        />
        <StatCard label="完成率" value={`${rate}%`} accent="text-violet-600" />
        <StatCard
          label="连续天数"
          value={`${achievement.streakDays} 天`}
          accent="text-amber-600"
        />
      </div>

      <div className="card p-5 mb-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="font-semibold text-stone-900">结构化复盘趋势</h2>
            <p className="text-xs text-stone-500 mt-1">正确率、薄弱点占比与累计学习时长来自服务端复盘记录。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <select className="input-field w-auto py-1.5 text-xs" value={goalFilter} onChange={(event) => setGoalFilter(event.target.value)}>
              <option value="">全部目标</option>
              {ws.plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.goal}</option>)}
            </select>
            <input type="date" className="input-field w-auto py-1.5 text-xs" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
            <input type="date" className="input-field w-auto py-1.5 text-xs" value={toDate} onChange={(event) => setToDate(event.target.value)} />
            <button className="btn-ghost py-1.5 text-xs" onClick={() => void loadServerReports()}>筛选</button>
          </div>
        </div>
        {serverError && <p className="mt-2 text-xs text-rose-600">{serverError}</p>}
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-xl bg-[#FBF9F4] p-3">
            <div className="text-xs font-medium text-stone-600 mb-2">正确率走势</div>
            {accuracyPoints.length ? (
              <svg viewBox="0 0 300 100" className="h-28 w-full">
                <line x1="10" y1="90" x2="290" y2="90" stroke="#e7dfd0" />
                <polyline
                  points={accuracyPoints.map((report, index) => {
                    const x = 10 + (index * 280) / Math.max(1, accuracyPoints.length - 1);
                    const y = 90 - Number(report.accuracy ?? 0) * 80;
                    return `${x},${y}`;
                  }).join(" ")}
                  fill="none"
                  stroke="#D95427"
                  strokeWidth="3"
                />
              </svg>
            ) : <p className="py-8 text-center text-xs text-stone-400">填写题目统计并生成复盘后显示</p>}
          </div>
          <div className="rounded-xl bg-[#FBF9F4] p-3">
            <div className="text-xs font-medium text-stone-600 mb-2">薄弱知识点占比</div>
            <div className="space-y-2">
              {topWeaknesses.map(([name, count]) => (
                <div key={name}>
                  <div className="flex justify-between text-xs text-stone-600"><span className="truncate">{name}</span><span>{count}</span></div>
                  <div className="mt-1 h-1.5 rounded-full bg-stone-200"><div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.round((count / Math.max(1, serverReports.length)) * 100)}%` }} /></div>
                </div>
              ))}
              {!topWeaknesses.length && <p className="py-8 text-center text-xs text-stone-400">暂无薄弱点数据</p>}
            </div>
          </div>
        </div>
        <p className="mt-3 text-xs text-stone-500">
          服务端累计学习时长：{Math.round(serverReports.reduce((sum, report) => sum + Number(report.focusSeconds ?? 0), 0) / 60)} 分钟
        </p>
      </div>

      {(urgency.todayLeft > 0 ||
        (urgency.daysSinceLastComplete !== null &&
          urgency.daysSinceLastComplete >= 2) ||
        (urgency.nearestDeadlineDays !== null &&
          urgency.nearestDeadlineDays <= 14)) && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <div className="font-medium mb-0.5">节奏提醒</div>
          <ul className="text-amber-800/90 space-y-0.5 list-disc pl-4">
            {urgency.todayLeft > 0 && (
              <li>今日还有 {urgency.todayLeft} 项未完成，收工前先勾掉一项。</li>
            )}
            {urgency.daysSinceLastComplete !== null &&
              urgency.daysSinceLastComplete >= 2 && (
                <li>
                  已连续 {urgency.daysSinceLastComplete}{" "}
                  天没有完成记录，连续天数即将中断。
                </li>
              )}
            {urgency.daysSinceLastComplete === null && totalToday > 0 && (
              <li>还没有完成记录——从今天的第一项高优先级任务开始。</li>
            )}
            {urgency.nearestDeadlineDays !== null &&
              urgency.nearestDeadlineDays <= 14 &&
              urgency.nearestGoal && (
                <li>
                  「{urgency.nearestGoal}」距截止还有{" "}
                  {Math.max(0, urgency.nearestDeadlineDays)} 天。
                </li>
              )}
          </ul>
        </div>
      )}

      {taskAiReviews.length > 0 && (
        <div className="card p-5 mb-4">
          <h2 className="font-semibold text-slate-900 mb-1">任务 AI 复盘</h2>
          <p className="text-xs text-slate-500 mb-3">
            来自学习日「一键AI复盘」，按任务生成的分步复盘报告。
          </p>
          <div className="space-y-3">
            {taskAiReviews.slice(0, 8).map((r) => (
              <div
                key={r.id}
                className={`rounded-xl border px-3 py-3 ${
                  highlightTaskId === r.taskId
                    ? "border-brand-300 bg-brand-50"
                    : "border-slate-100 bg-slate-50/80"
                }`}
              >
                <div className="flex items-start justify-between gap-2 mb-1.5">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900 truncate">
                      {r.taskTitle}
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      {r.goalTitle || "临时"} · {r.date} · 专注{" "}
                      {Math.round(r.focusSeconds / 60)} 分钟
                    </div>
                  </div>
                </div>
                {r.checkCriteria && (
                  <p className="text-xs font-bold text-stone-800 mb-1.5">
                    自检：{r.checkCriteria}
                  </p>
                )}
                <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">
                  {r.report}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card p-5 mb-4">
        <h2 className="font-semibold text-slate-900 mb-2">今日总结</h2>
        <p className="text-sm text-slate-600">
          进行中目标：
          {activeGoals.length === 0
            ? "无（今日可能只有临时任务）"
            : activeGoals.map((g) => g.goal).join("、")}
        </p>
        {todayReview?.aiSuggestion ? (
          <p className="mt-3 text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2">
            {todayReview.aiSuggestion}
          </p>
        ) : (
          <p className="mt-3 text-sm text-slate-500">
            今天还没有收工记录。去学习日完成任务或点「累了，明天再搞」后，这里会显示总结。
          </p>
        )}
      </div>

      <div className="card p-5 mb-4">
        <h2 className="font-semibold text-slate-900 mb-3">未完成与原因</h2>
        {todayReview && todayReview.unfinishedTitles?.length > 0 ? (
          <div className="space-y-2">
            {todayReview.unfinishedTitles.map((title) => (
              <div
                key={title}
                className="flex items-center justify-between text-sm rounded-lg bg-slate-50 px-3 py-2"
              >
                <span className="text-slate-700">{title}</span>
                <span className="text-xs text-amber-600">
                  {todayReview.reason
                    ? SKIP_REASON_LABELS[todayReview.reason]
                    : "已记录"}
                </span>
              </div>
            ))}
            {todayReview.difficulty && (
              <p className="text-xs text-slate-500 mt-2">
                备注：{todayReview.difficulty}
              </p>
            )}
          </div>
        ) : completedToday === totalToday && totalToday > 0 ? (
          <p className="text-sm text-emerald-600">今日全部完成，没有未完成项。</p>
        ) : (
          <p className="text-sm text-slate-500">
            暂无收工记录。若今日有未完成任务，请在学习日点「累了，明天再搞」。
          </p>
        )}
      </div>

      <div className="card p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-slate-900">未完成池</h2>
          <span className="text-xs text-slate-400">{backlog.length} 条待处理</span>
        </div>
        {backlog.length === 0 ? (
          <p className="text-sm text-slate-500">池子是空的，很好。</p>
        ) : (
          <div className="space-y-2">
            {backlog.slice(0, 8).map((b) => (
              <div
                key={b.id}
                className="text-sm rounded-lg border border-slate-100 px-3 py-2"
              >
                <div className="font-medium text-slate-800">{b.title}</div>
                <div className="text-xs text-slate-400 mt-0.5">
                  {b.goalTitle || "临时"} · {b.sourceDate} ·{" "}
                  {SKIP_REASON_LABELS[b.reason]}
                </div>
              </div>
            ))}
            <p className="text-xs text-slate-400 pt-1">
              下次进入学习日时，可逐条选择「加入今日 / 先放着 / 放弃」。
            </p>
          </div>
        )}
      </div>

      <div className="card p-5 mb-4">
        <h2 className="font-semibold text-slate-900 mb-3">明日预告</h2>
        {tomorrowTasks.length === 0 ? (
          <p className="text-sm text-slate-500">
            明天暂无已排任务。未完成池项目可在明天选择加入。
          </p>
        ) : (
          <ul className="space-y-1.5">
            {tomorrowTasks.map((t) => (
              <li
                key={t.id}
                className="text-sm text-slate-700 flex justify-between gap-2"
              >
                <span>
                  <span className="text-xs text-slate-400 mr-2">
                    {t.goalTitle || "临时"}
                  </span>
                  {t.title}
                </span>
                <span className="text-xs text-slate-400 shrink-0">
                  {t.suggestedMinutes} 分
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card p-5 mb-6">
        <h2 className="font-semibold text-slate-900 mb-1">里程碑徽章</h2>
        <p className="text-xs text-slate-500 mb-4">
          按每个大目标单独计算进度（不含临时任务）。多目标互不影响解锁。
        </p>

        {goalMilestones.length === 0 ? (
          <p className="text-sm text-slate-500">
            暂无进行中的大目标。去规划页新建并拆解后，这里会出现分目标徽章。
          </p>
        ) : (
          <div className="space-y-5">
            {goalMilestones.map((g) => (
              <div key={g.planId} className="rounded-xl border border-slate-100 p-4">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900 truncate">
                      {g.goal}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      进度 {Math.round(g.progress * 100)}% · 专注 {g.focusMinutes}{" "}
                      分钟 · 复盘 {REVIEW_CYCLE_LABELS[g.reviewCycle]}
                      {g.daysToDeadline !== null &&
                        ` · 截止 ${g.daysToDeadline} 天`}
                    </div>
                  </div>
                  {g.reviewDue && (
                    <span className="shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-100">
                      该复盘了
                    </span>
                  )}
                </div>
                <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden mb-3">
                  <div
                    className="h-full bg-brand-500 rounded-full transition-all"
                    style={{
                      width: `${Math.min(100, Math.round(g.progress * 100))}%`,
                    }}
                  />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      { k: "milestone25" as const, l: "25% 起步", e: "🏆" },
                      { k: "milestone50" as const, l: "50% 过半", e: "🥈" },
                      { k: "milestone100" as const, l: "100% 达成", e: "🥇" },
                    ] as const
                  ).map((m) => {
                    const unlocked = g[m.k];
                    return (
                      <div
                        key={m.k}
                        className={`rounded-xl p-3 text-center border transition ${
                          unlocked
                            ? "bg-amber-50 border-amber-200"
                            : "bg-slate-50 border-slate-100 opacity-60"
                        }`}
                      >
                        <div className="text-xl mb-0.5">{m.e}</div>
                        <div className="text-[11px] text-slate-700">{m.l}</div>
                        <div className="text-[10px] text-slate-400 mt-0.5">
                          {unlocked ? "已解锁" : "未解锁"}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="text-xs text-slate-400 mt-4 text-center">
          全部大目标合计进度 {Math.round(progress * 100)}% · 累计专注{" "}
          {achievement.totalFocusMinutes} 分钟 · 连续 {achievement.streakDays} 天
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Link to="/schedule" className="btn-primary">
          查看学习日
        </Link>
        <Link to="/planner" className="btn-ghost">
          去规划页
        </Link>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="card p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-xl font-bold mt-1 ${accent}`}>{value}</div>
    </div>
  );
}
