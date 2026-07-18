import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import TaskCard from "../components/TaskCard";
import type { BacklogItem, SkipReason, TaskItem, Workspace } from "../types/plan";
import { SKIP_REASON_LABELS } from "../types/plan";
import {
  addAdhocTask,
  addBacklogItemToToday,
  appendReview,
  buildEncouragement,
  cancelBacklogItem,
  computeAchievement,
  getBacklogPromptDate,
  getPendingBacklog,
  getTodayTasksFromWorkspace,
  loadReviews,
  loadWorkspace,
  pushUnfinishedToBacklog,
  setBacklogPromptDate,
  syncFocusFromTimers,
  todayStr,
  uid,
  updateTaskEverywhere,
  type DayTask,
} from "../lib/storage";

export default function SchedulePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [ws, setWs] = useState<Workspace>(() => loadWorkspace());
  const [pendingBacklog, setPendingBacklog] = useState<BacklogItem[]>(() =>
    getPendingBacklog()
  );
  const [showBacklogPrompt, setShowBacklogPrompt] = useState(false);
  const [showSkipModal, setShowSkipModal] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [skipReason, setSkipReason] = useState<SkipReason>("too_tired");
  const [skipNote, setSkipNote] = useState("");
  const [adhocTitle, setAdhocTitle] = useState("");
  const [adhocMinutes, setAdhocMinutes] = useState(30);
  const [adhocGoalId, setAdhocGoalId] = useState<string>("");
  const [decomposeToast, setDecomposeToast] = useState<string | null>(null);

  useEffect(() => {
    setWs(loadWorkspace());
    setPendingBacklog(getPendingBacklog());
    // 拆解成功跳转过来的提示
    if (location.state?.decomposeSuccess) {
      const todayCount = Number(location.state.taskCount) || 0;
      const total = Number(location.state.totalTaskCount) || todayCount;
      setDecomposeToast(
        todayCount > 0
          ? `AI 已拆解完成：今日 ${todayCount} 项，全计划共 ${total} 项`
          : `AI 已拆解完成：全计划共 ${total} 项（今日暂无排期）`,
      );
      const timer = setTimeout(() => setDecomposeToast(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [location.key]);

  const today = todayStr();
  const activeGoals = useMemo(
    () => ws.plans.filter((p) => (p.status ?? "active") === "active"),
    [ws]
  );

  const todayTasks: DayTask[] = useMemo(() => {
    return getTodayTasksFromWorkspace(ws);
  }, [ws, pendingBacklog]);

  const doneCount = todayTasks.filter((t) => t.completed).length;
  const allDone = todayTasks.length > 0 && doneCount === todayTasks.length;
  const focusMinutes = Math.round(
    todayTasks.reduce((s, t) => s + t.focusSeconds, 0) / 60
  );

  useEffect(() => {
    const pending = getPendingBacklog().filter((b) => b.sourceDate < today);
    setPendingBacklog(getPendingBacklog());
    if (pending.length === 0) return;
    if (getBacklogPromptDate() === today) return;
    setShowBacklogPrompt(true);
  }, [today]);

  const handleToggle = (id: string) => {
    const task = todayTasks.find((t) => t.id === id);
    if (!task) return;
    setWs(updateTaskEverywhere(id, { completed: !task.completed }));
  };

  const handleEdit = (id: string, patch: Partial<TaskItem>) => {
    setWs(updateTaskEverywhere(id, patch));
  };

  const handleAddAdhoc = () => {
    if (!adhocTitle.trim()) return;
    const next = addAdhocTask({
      title: adhocTitle.trim(),
      suggestedMinutes: adhocMinutes,
      goalId: adhocGoalId || undefined,
    });
    setWs(next);
    setAdhocTitle("");
    setAdhocMinutes(30);
    setAdhocGoalId("");
    setShowAddModal(false);
  };

  const handleCheckIn = () => {
    if (!allDone) return;
    const synced = syncFocusFromTimers(ws);
    setWs(synced);
    const tasks = getTodayTasksFromWorkspace(synced);
    const mins = Math.round(
      tasks.reduce((s, t) => s + t.focusSeconds, 0) / 60
    );
    const reviews = loadReviews();
    const achievement = computeAchievement(synced, reviews);
    appendReview({
      id: uid(),
      date: today,
      completedIds: tasks.map((t) => t.id),
      unfinishedIds: [],
      unfinishedTitles: [],
      difficulty: "",
      focusMinutes: mins,
      completedCount: tasks.length,
      totalCount: tasks.length,
      action: "checkin_complete",
      aiSuggestion: buildEncouragement(
        tasks.length,
        tasks.length,
        mins,
        achievement.streakDays + 1
      ),
    });
    navigate("/checkin");
  };

  const handleSkipConfirm = () => {
    const synced = syncFocusFromTimers(ws);
    setWs(synced);
    const tasks = getTodayTasksFromWorkspace(synced);
    const unfinished = tasks.filter((t) => !t.completed);
    const completed = tasks.filter((t) => t.completed);
    const mins = Math.round(
      tasks.reduce((s, t) => s + t.focusSeconds, 0) / 60
    );

    pushUnfinishedToBacklog(unfinished, skipReason, skipNote.trim());
    setPendingBacklog(getPendingBacklog());

    appendReview({
      id: uid(),
      date: today,
      completedIds: completed.map((t) => t.id),
      unfinishedIds: unfinished.map((t) => t.id),
      unfinishedTitles: unfinished.map((t) => t.title),
      reason: skipReason,
      difficulty: skipNote.trim() || SKIP_REASON_LABELS[skipReason],
      focusMinutes: mins,
      completedCount: completed.length,
      totalCount: tasks.length,
      action: "skip_to_backlog",
      aiSuggestion: buildEncouragement(
        completed.length,
        tasks.length,
        mins,
        computeAchievement(synced, loadReviews()).streakDays
      ),
    });

    setShowSkipModal(false);
    setSkipNote("");
    navigate("/progress");
  };

  const handleAddBacklog = (backlogId: string) => {
    setWs(addBacklogItemToToday(backlogId));
    setPendingBacklog(getPendingBacklog());
  };

  const handleKeepBacklog = (backlogId: string) => {
    setPendingBacklog((prev) => prev.filter((b) => b.id !== backlogId));
  };

  const handleCancelBacklog = (backlogId: string) => {
    cancelBacklogItem(backlogId);
    setPendingBacklog(getPendingBacklog());
  };

  const closeBacklogPrompt = () => {
    setBacklogPromptDate(today);
    setShowBacklogPrompt(false);
    setPendingBacklog(getPendingBacklog());
  };

  const promptItems = pendingBacklog.filter((b) => b.sourceDate < today);
  const hasAnyGoal = activeGoals.length > 0;
  const hasAnyTaskEver =
    ws.plans.some((p) => p.tasks.length > 0) || ws.adhocTasks.length > 0;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 pb-28">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">学习日</h1>
          <p className="text-sm text-slate-500 mt-1">
            {today}
            {activeGoals.length > 0 &&
              ` · ${activeGoals.length} 个进行中目标`}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            className="btn-primary text-sm py-1.5"
            onClick={() => setShowAddModal(true)}
          >
            + 今日任务
          </button>
          <Link to="/planner" className="btn-ghost text-sm py-1.5">
            目标规划
          </Link>
        </div>
      </div>

      {decomposeToast && (
        <div className="mb-4 rounded-xl bg-brand-50 border border-brand-200 px-4 py-3 text-sm text-brand-700 flex items-center gap-2 animate-fade-in">
          <span className="text-lg">✨</span>
          {decomposeToast}
        </div>
      )}

      <div className="card p-4 mb-6 flex flex-wrap items-center gap-4">
        <div>
          <div className="text-xs text-slate-500">今日进度</div>
          <div className="text-xl font-bold text-brand-600">
            {doneCount}/{todayTasks.length}
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-500">预计时长</div>
          <div className="text-xl font-bold text-slate-800">
            {todayTasks.reduce((s, t) => s + t.suggestedMinutes, 0)} 分钟
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-500">已专注</div>
          <div className="text-xl font-bold text-emerald-600">
            {focusMinutes} 分钟
          </div>
        </div>
        {pendingBacklog.filter((b) => b.status === "pending").length > 0 && (
          <div className="ml-auto text-xs text-amber-600 bg-amber-50 px-3 py-1.5 rounded-full">
            未完成池{" "}
            {pendingBacklog.filter((b) => b.status === "pending").length} 条
          </div>
        )}
      </div>

      {!hasAnyGoal && !hasAnyTaskEver ? (
        <div className="card p-8 md:p-12 text-center animate-slide-up">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-50 text-3xl">
            📅
          </div>
          <h2 className="text-xl font-semibold text-slate-900">
            今天从一件小事开始
          </h2>
          <p className="mt-2 text-sm text-slate-500 max-w-md mx-auto">
            学习日可以放「大目标排期」的任务，也可以直接加当天临时任务——不一定非要先拆解大目标。
          </p>
          <div className="mt-6 flex flex-col sm:flex-row gap-2 justify-center">
            <button
              className="btn-primary"
              onClick={() => setShowAddModal(true)}
            >
              + 添加今日任务
            </button>
            <Link to="/planner" className="btn-ghost">
              或去拆解大目标
            </Link>
          </div>
        </div>
      ) : todayTasks.length === 0 ? (
        <div className="card p-8 text-center animate-slide-up">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-2xl">
            ☕
          </div>
          <h2 className="text-lg font-semibold text-slate-900">
            今天还没有任务
          </h2>
          <p className="mt-2 text-sm text-slate-500 max-w-sm mx-auto">
            可以随手加一条临时任务，或去目标规划把任务排到今天。
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <button
              className="btn-primary"
              onClick={() => setShowAddModal(true)}
            >
              + 添加今日任务
            </button>
            <Link to="/planner" className="btn-ghost">
              去规划页
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {todayTasks.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
              goalLabel={
                t.source === "adhoc" || !t.goalId
                  ? "临时"
                  : t.goalTitle ?? "目标"
              }
              onToggleComplete={handleToggle}
              onEdit={handleEdit}
            />
          ))}
        </div>
      )}

      {todayTasks.length > 0 && (
        <div className="fixed bottom-0 inset-x-0 z-20 border-t border-slate-100 bg-white/95 backdrop-blur">
          <div className="max-w-4xl mx-auto px-4 py-3 flex flex-col sm:flex-row gap-2">
            <button
              className="btn-primary flex-1"
              disabled={!allDone}
              onClick={handleCheckIn}
            >
              {allDone
                ? "完成今日打卡"
                : `完成今日打卡（还需 ${todayTasks.length - doneCount} 项）`}
            </button>
            <button
              className="btn-ghost flex-1"
              disabled={doneCount === todayTasks.length}
              onClick={() => setShowSkipModal(true)}
            >
              累了，明天再搞
            </button>
          </div>
        </div>
      )}

      {/* 添加今日任务 */}
      {showAddModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={() => setShowAddModal(false)}
        >
          <div
            className="card w-full max-w-md p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-slate-900">
              添加今日任务
            </h2>
            <p className="text-xs text-slate-500 mt-1 mb-4">
              当天想到的事可以直接加，不必挂到大目标。
            </p>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              任务名称
            </label>
            <input
              className="input-field mb-3"
              placeholder="例如：改简历一版 / 背 50 个单词"
              value={adhocTitle}
              onChange={(e) => setAdhocTitle(e.target.value)}
              autoFocus
            />
            <label className="block text-sm font-medium text-slate-700 mb-1">
              预计分钟
            </label>
            <input
              type="number"
              min={5}
              className="input-field mb-3 w-32"
              value={adhocMinutes}
              onChange={(e) => setAdhocMinutes(Number(e.target.value) || 30)}
            />
            <label className="block text-sm font-medium text-slate-700 mb-1">
              关联大目标（可选）
            </label>
            <select
              className="input-field mb-4"
              value={adhocGoalId}
              onChange={(e) => setAdhocGoalId(e.target.value)}
            >
              <option value="">不关联 · 记为临时任务</option>
              {activeGoals.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.goal}
                </option>
              ))}
            </select>
            <div className="flex gap-2">
              <button
                className="btn-primary flex-1"
                disabled={!adhocTitle.trim()}
                onClick={handleAddAdhoc}
              >
                添加到今天
              </button>
              <button
                className="btn-ghost flex-1"
                onClick={() => setShowAddModal(false)}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {showBacklogPrompt && promptItems.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/40 p-4">
          <div className="card w-full max-w-lg p-5 max-h-[80vh] overflow-y-auto">
            <h2 className="text-lg font-semibold text-slate-900">
              昨日有未完成任务
            </h2>
            <p className="text-sm text-slate-500 mt-1 mb-4">
              不会自动塞进今天。请逐条选择：加入今日、先放着，或放弃。
            </p>
            <div className="space-y-3">
              {promptItems.map((b) => (
                <div
                  key={b.id}
                  className="rounded-xl border border-slate-100 p-3"
                >
                  <div className="font-medium text-slate-900">{b.title}</div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {b.goalTitle || "临时"} · {b.suggestedMinutes} 分钟 ·{" "}
                    {SKIP_REASON_LABELS[b.reason]}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <button
                      className="px-3 py-1.5 rounded-lg text-xs bg-brand-50 text-brand-600 hover:bg-brand-100"
                      onClick={() => handleAddBacklog(b.id)}
                    >
                      加入今日
                    </button>
                    <button
                      className="px-3 py-1.5 rounded-lg text-xs bg-slate-50 text-slate-600 hover:bg-slate-100"
                      onClick={() => handleKeepBacklog(b.id)}
                    >
                      先放着
                    </button>
                    <button
                      className="px-3 py-1.5 rounded-lg text-xs bg-rose-50 text-rose-600 hover:bg-rose-100"
                      onClick={() => handleCancelBacklog(b.id)}
                    >
                      放弃
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button
              className="btn-primary w-full mt-4"
              onClick={closeBacklogPrompt}
            >
              完成选择，开始今天
            </button>
          </div>
        </div>
      )}

      {showSkipModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={() => setShowSkipModal(false)}
        >
          <div
            className="card w-full max-w-md p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-slate-900">
              累了，明天再搞
            </h2>
            <p className="text-sm text-slate-500 mt-1 mb-4">
              还有 {todayTasks.length - doneCount}{" "}
              项未完成。会记入未完成池，不会强行改明天安排。
            </p>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              原因
            </label>
            <div className="flex flex-wrap gap-2 mb-3">
              {(Object.keys(SKIP_REASON_LABELS) as SkipReason[]).map((r) => (
                <button
                  key={r}
                  onClick={() => setSkipReason(r)}
                  className={`px-3 py-1.5 rounded-lg text-xs border ${
                    skipReason === r
                      ? "bg-brand-50 border-brand-300 text-brand-600"
                      : "bg-white border-slate-200 text-slate-600"
                  }`}
                >
                  {SKIP_REASON_LABELS[r]}
                </button>
              ))}
            </div>
            <textarea
              className="input-field min-h-[72px] mb-4"
              placeholder="补充一句（可选）"
              value={skipNote}
              onChange={(e) => setSkipNote(e.target.value)}
            />
            <div className="flex gap-2">
              <button className="btn-primary flex-1" onClick={handleSkipConfirm}>
                确认收工
              </button>
              <button
                className="btn-ghost flex-1"
                onClick={() => setShowSkipModal(false)}
              >
                再想想
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
