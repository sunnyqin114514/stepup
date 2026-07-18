import { useMemo } from "react";
import { Link } from "react-router-dom";
import {
  computeAchievement,
  getTodayTasksFromWorkspace,
  loadReviews,
  loadWorkspace,
  todayStr,
} from "../lib/storage";

export default function CheckInPage() {
  const ws = loadWorkspace();
  const reviews = loadReviews();
  const today = todayStr();

  const todayReview = useMemo(
    () =>
      reviews
        .filter((r) => r.date === today && r.action === "checkin_complete")
        .at(-1) ?? null,
    [reviews, today]
  );

  const todayTasks = getTodayTasksFromWorkspace(ws);
  const doneCount =
    todayReview?.completedCount ??
    todayTasks.filter((t) => t.completed).length;
  const totalCount = todayReview?.totalCount ?? todayTasks.length;
  const focusMinutes =
    todayReview?.focusMinutes ??
    Math.round(todayTasks.reduce((s, t) => s + t.focusSeconds, 0) / 60);
  const achievement = computeAchievement(ws, reviews);
  const encouragement =
    todayReview?.aiSuggestion ??
    `今日 ${doneCount}/${totalCount} 全部完成，专注 ${focusMinutes} 分钟。`;

  return (
    <div className="min-h-[70vh] flex items-center justify-center px-4 py-12 bg-[#F7F3EB]">
      <div className="max-w-md w-full text-center animate-slide-up">
        <div className="relative w-36 h-36 mx-auto mb-6">
          <svg viewBox="0 0 36 36" className="w-36 h-36 -rotate-90">
            <circle
              cx="18"
              cy="18"
              r="15"
              fill="none"
              stroke="#e2e8f0"
              strokeWidth="2.5"
            />
            <circle
              cx="18"
              cy="18"
              r="15"
              fill="none"
              stroke="#10b981"
              strokeWidth="2.5"
              strokeDasharray="100 100"
              strokeLinecap="round"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div className="text-2xl font-bold text-emerald-600">100%</div>
            <div className="text-[10px] text-slate-400">今日完成</div>
          </div>
        </div>

        <h1 className="text-2xl md:text-3xl font-bold text-slate-900">
          今日任务全部完成！
        </h1>
        <p className="mt-3 text-slate-600 text-sm leading-relaxed">
          {encouragement}
        </p>

        <div className="mt-6 grid grid-cols-3 gap-3">
          <div className="card p-3">
            <div className="text-xs text-slate-500">完成</div>
            <div className="text-lg font-bold text-brand-600">
              {doneCount}/{totalCount}
            </div>
          </div>
          <div className="card p-3">
            <div className="text-xs text-slate-500">专注</div>
            <div className="text-lg font-bold text-emerald-600">
              {focusMinutes} 分
            </div>
          </div>
          <div className="card p-3">
            <div className="text-xs text-slate-500">连续</div>
            <div className="text-lg font-bold text-amber-600">
              {achievement.streakDays} 天
            </div>
          </div>
        </div>

        <div className="mt-6 card p-4">
          <div className="text-xs text-slate-500 mb-2">今日徽章</div>
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-amber-50 text-amber-700 text-sm font-medium">
            <span>🏅</span>
            稳定推进者
          </div>
        </div>

        <div className="mt-8 flex flex-col sm:flex-row gap-2 justify-center">
          <Link to="/progress" className="btn-primary">
            查看复盘
          </Link>
          <Link to="/schedule" className="btn-ghost">
            回到学习日
          </Link>
        </div>
      </div>
    </div>
  );
}
