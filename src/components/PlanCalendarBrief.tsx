import { useMemo } from "react";
import type { TaskItem } from "../types/plan";
import { localDateStr, parseLocalDate } from "../lib/scheduleDates";

type Props = {
  tasks: TaskItem[];
  restDates: string[];
  selectedDate: string | null;
  /** 当月任意一天，组件按年月渲染 */
  monthCursor: string;
  onSelectDate: (date: string) => void;
  onMonthChange: (monthCursor: string) => void;
  onShowAll: () => void;
};

const WEEK_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

function monthStartStr(cursor: string): string {
  const d = parseLocalDate(cursor);
  return localDateStr(new Date(d.getFullYear(), d.getMonth(), 1));
}

function shiftMonth(cursor: string, delta: number): string {
  const d = parseLocalDate(monthStartStr(cursor));
  return localDateStr(new Date(d.getFullYear(), d.getMonth() + delta, 1));
}

function formatMonthTitle(cursor: string): string {
  const d = parseLocalDate(monthStartStr(cursor));
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

function formatDaySummary(date: string): string {
  const d = parseLocalDate(date);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export default function PlanCalendarBrief({
  tasks,
  restDates,
  selectedDate,
  monthCursor,
  onSelectDate,
  onMonthChange,
  onShowAll,
}: Props) {
  const today = localDateStr();
  const restSet = useMemo(() => new Set(restDates), [restDates]);

  const counts = useMemo(() => {
    const map: Record<string, { count: number; minutes: number }> = {};
    for (const task of tasks) {
      const date = task.date;
      if (!date) continue;
      const cur = map[date] ?? { count: 0, minutes: 0 };
      cur.count += 1;
      cur.minutes += Math.max(0, Number(task.suggestedMinutes) || 0);
      map[date] = cur;
    }
    return map;
  }, [tasks]);

  const cells = useMemo(() => {
    const start = parseLocalDate(monthStartStr(monthCursor));
    const year = start.getFullYear();
    const month = start.getMonth();
    // JS: 0=Sun … 转成周一为一周起点 → 0=Mon
    const firstDow = (start.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const grid: Array<{ date: string; inMonth: boolean } | null> = [];

    for (let i = 0; i < firstDow; i += 1) {
      grid.push(null);
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = localDateStr(new Date(year, month, day));
      grid.push({ date, inMonth: true });
    }
    while (grid.length % 7 !== 0) {
      grid.push(null);
    }
    return grid;
  }, [monthCursor]);

  const summary = useMemo(() => {
    if (!selectedDate) return null;
    const stats = counts[selectedDate];
    const isRest = restSet.has(selectedDate);
    if (stats && stats.count > 0) {
      return `${formatDaySummary(selectedDate)} · ${stats.count} 个任务 · ${stats.minutes} 分钟`;
    }
    if (isRest) {
      return `${formatDaySummary(selectedDate)} · 休息日`;
    }
    return `${formatDaySummary(selectedDate)} · 暂无任务`;
  }, [selectedDate, counts, restSet]);

  return (
    <div className="card p-4 mb-6">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="font-semibold text-slate-900 text-sm">计划简报</h2>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="text-xs text-stone-600 hover:text-[#c0451f] px-2 py-1 rounded-lg border border-[#e0d6c2] bg-white"
            onClick={() => onMonthChange(shiftMonth(monthCursor, -1))}
          >
            ‹ 上月
          </button>
          <span className="text-xs font-medium text-stone-700 min-w-[5.5rem] text-center">
            {formatMonthTitle(monthCursor)}
          </span>
          <button
            type="button"
            className="text-xs text-stone-600 hover:text-[#c0451f] px-2 py-1 rounded-lg border border-[#e0d6c2] bg-white"
            onClick={() => onMonthChange(shiftMonth(monthCursor, 1))}
          >
            下月 ›
          </button>
          <button
            type="button"
            className="text-xs text-[#c0451f] hover:underline px-1"
            onClick={onShowAll}
          >
            查看全部任务
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1 mb-1">
        {WEEK_LABELS.map((label) => (
          <div
            key={label}
            className="text-center text-[10px] text-stone-400 py-1"
          >
            {label}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((cell, index) => {
          if (!cell) {
            return <div key={`empty-${index}`} className="aspect-square" />;
          }
          const { date } = cell;
          const stats = counts[date];
          const taskCount = stats?.count ?? 0;
          const isRest = restSet.has(date);
          const isToday = date === today;
          const isSelected = date === selectedDate;

          let cellClass =
            "aspect-square rounded-lg border text-left p-1 relative transition active:scale-95 ";
          if (isSelected) {
            cellClass += "border-[#d95427] bg-orange-50 ";
          } else if (isToday) {
            cellClass += "border-[#e09a7a] bg-white ";
          } else if (isRest && taskCount === 0) {
            cellClass += "border-dashed border-stone-200 bg-stone-50/80 ";
          } else if (taskCount > 0) {
            cellClass += "border-[#ede6d8] bg-white hover:border-[#e09a7a] ";
          } else {
            cellClass += "border-transparent bg-transparent text-stone-300 ";
          }

          return (
            <button
              key={date}
              type="button"
              className={cellClass}
              onClick={() => onSelectDate(date)}
              aria-label={`${date}${taskCount ? ` ${taskCount}个任务` : isRest ? " 休息日" : ""}`}
            >
              <span
                className={`text-[11px] font-medium leading-none ${
                  isSelected
                    ? "text-[#c0451f]"
                    : isToday
                      ? "text-[#d95427]"
                      : taskCount > 0
                        ? "text-stone-800"
                        : "text-stone-400"
                }`}
              >
                {parseLocalDate(date).getDate()}
              </span>
              {taskCount > 0 ? (
                <span className="absolute bottom-0.5 right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-[#d95427] text-white text-[9px] leading-[14px] text-center font-semibold">
                  {taskCount > 9 ? "9+" : taskCount}
                </span>
              ) : isRest ? (
                <span className="absolute bottom-0.5 right-0.5 text-[9px] text-stone-400">
                  休
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {summary && (
        <p className="mt-3 text-xs text-stone-600 px-0.5">{summary}</p>
      )}
    </div>
  );
}

export function monthCursorFromDate(dateStr: string): string {
  return monthStartStr(dateStr);
}
