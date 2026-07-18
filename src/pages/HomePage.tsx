import { Link } from "react-router-dom";
import { useMemo, useState } from "react";
import LogoMark from "../components/LogoMark";
import ProBadge from "../components/ProBadge";
import type { TaskItem } from "../types/plan";
import {
  computeAchievement,
  getTodayTasksFromWorkspace,
  getTomorrowTasksFromWorkspace,
  loadReviews,
  loadWorkspace,
  todayStr,
  updateTaskEverywhere,
} from "../lib/storage";

type LegacyTodayTask = {
  id: string;
  title: string;
  subject?: string;
  minutes?: number;
  completed?: boolean;
  completedAt?: string | null;
  date?: string;
  source?: string;
  isYesterdayLeftover?: boolean;
};

type HomeTask = {
  id: string;
  title: string;
  subject: string;
  minutes: number;
  completed: boolean;
  completedAt?: string | null;
  isYesterdayLeftover: boolean;
  source: "legacy" | "workspace";
};

function loadLegacyTodayTasks(): LegacyTodayTask[] {
  try {
    const raw = localStorage.getItem("todayTasks");
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((task): task is LegacyTodayTask => Boolean(task && typeof task === "object"))
      .filter((task) => !task.date || task.date === todayStr());
  } catch (error) {
    console.error("读取 todayTasks 失败，回退到 workspace", error);
    return [];
  }
}

function saveLegacyToggle(taskId: string): HomeTask[] {
  const raw = localStorage.getItem("todayTasks");
  const parsed = raw ? (JSON.parse(raw) as unknown) : [];
  const tasks = Array.isArray(parsed) ? (parsed as LegacyTodayTask[]) : [];
  const next = tasks.map((task) => {
    if (task.id !== taskId) return task;
    const completed = !Boolean(task.completed);
    return {
      ...task,
      completed,
      completedAt: completed ? new Date().toISOString() : null,
    };
  });
  localStorage.setItem("todayTasks", JSON.stringify(next));
  return next
    .filter((task) => !task.date || task.date === todayStr())
    .map(toHomeTaskFromLegacy)
    .slice(0, 3);
}

function toHomeTaskFromLegacy(task: LegacyTodayTask): HomeTask {
  return {
    id: task.id,
    title: task.title,
    subject: task.subject || subjectFromTitle(task.title),
    minutes: Number(task.minutes) || 30,
    completed: Boolean(task.completed),
    completedAt: task.completedAt ?? null,
    isYesterdayLeftover: Boolean(task.isYesterdayLeftover),
    source: "legacy",
  };
}

function toHomeTaskFromWorkspace(task: TaskItem & { goalTitle?: string }): HomeTask {
  return {
    id: task.id,
    title: task.title,
    subject: task.subject || task.subGoal || task.topicTags?.[0] || task.goalTitle || "任务",
    minutes: Number(task.suggestedMinutes) || 30,
    completed: Boolean(task.completed),
    completedAt: task.completed ? new Date().toISOString() : null,
    isYesterdayLeftover: Boolean(task.fromBacklog),
    source: "workspace",
  };
}

function subjectFromTitle(title: string): string {
  const [first] = title.split(/[·：:｜|]/);
  return first?.trim() || "任务";
}

function greeting(done: number, total: number): string {
  const hour = new Date().getHours();
  const left = Math.max(0, total - done);
  if (hour >= 6 && hour < 12) return `早上好，今天有${total || 3}件事等你完成 ☀️`;
  if (hour >= 12 && hour < 18) return "下午好，继续加油 💪";
  return `晚上好，今天还剩${left}个任务 🌙`;
}

const FEATURES = [
  {
    to: "/planner",
    title: "AI 任务拆解",
    desc: "输入大目标，AI 拆成每日可执行任务",
    accent: "bg-brand-500",
    preview: (
      <div className="space-y-2 text-left w-full">
        <div className="text-[10px] text-stone-400">目标</div>
        <div className="h-7 rounded-md bg-[#F7F3EB] flex items-center px-2 text-xs text-stone-600">
          上线个人作品集
        </div>
        <div className="text-[10px] text-stone-400">第 1 天</div>
        <div className="space-y-1">
          {["澄清成功标准", "搭最小可演示骨架", "写一页进度说明"].map((t) => (
            <div
              key={t}
              className="flex items-center gap-2 text-xs text-stone-600"
            >
              <span className="w-3 h-3 rounded border border-stone-300" />
              {t}
            </div>
          ))}
        </div>
      </div>
    ),
  },
  {
    to: "/schedule",
    title: "学习日",
    desc: "今天做什么：大目标任务 + 临时任务",
    accent: "bg-brand-400",
    preview: (
      <div className="w-full text-left space-y-2">
        <div className="text-xs font-medium text-stone-800">今日目标</div>
        <div className="h-2.5 rounded-full bg-[#EDE6D8] overflow-hidden">
          <div className="h-full w-3/5 rounded-full bg-brand-500" />
        </div>
        <div className="text-[11px] text-stone-500">
          已完成 3 / 5 步 · 继续加油
        </div>
      </div>
    ),
  },
  {
    to: "/knowledge",
    title: "个人知识库",
    desc: "执行中沉淀笔记、错题与心得",
    accent: "bg-brand-300",
    pro: true,
    preview: (
      <div className="space-y-1.5 text-left w-full">
        {[
          { tag: "笔记", title: "需求对齐要点" },
          { tag: "复盘", title: "卡住时的绕行法" },
          { tag: "清单", title: "验收自检标准" },
        ].map((n) => (
          <div
            key={n.title}
            className="flex items-center gap-2 text-xs text-stone-600"
          >
            <span className="px-1.5 py-0.5 rounded bg-brand-50 text-brand-600 text-[10px]">
              {n.tag}
            </span>
            <span className="truncate">{n.title}</span>
          </div>
        ))}
      </div>
    ),
  },
  {
    to: "/review",
    title: "复习提醒",
    desc: "艾宾浩斯曲线，在最佳时机提醒你",
    accent: "bg-accent-500",
    pro: true,
    preview: (
      <div className="text-left w-full">
        <svg viewBox="0 0 120 50" className="w-full h-12">
          <path
            d="M5 8 Q 25 8, 35 22 T 70 32 T 115 38"
            fill="none"
            stroke="#D95427"
            strokeWidth="2"
          />
          {[10, 35, 70, 115].map((x) => (
            <circle
              key={x}
              cx={x}
              cy={x === 10 ? 8 : x === 35 ? 22 : x === 70 ? 32 : 38}
              r="2.5"
              fill="#D95427"
            />
          ))}
        </svg>
        <div className="text-[10px] text-stone-400 mt-1">今日待复习 3 条</div>
      </div>
    ),
  },
];

export default function HomePage() {
  const [ws, setWs] = useState(() => loadWorkspace());
  const [legacyTasks, setLegacyTasks] = useState<HomeTask[]>(() =>
    loadLegacyTodayTasks().map(toHomeTaskFromLegacy).slice(0, 3),
  );
  const [celebrating, setCelebrating] = useState(false);

  const reviews = useMemo(() => loadReviews(), [ws, legacyTasks]);
  const achievement = useMemo(() => computeAchievement(ws, reviews), [ws, reviews]);
  const workspaceTodayTasks = useMemo(
    () => getTodayTasksFromWorkspace(ws).map(toHomeTaskFromWorkspace).slice(0, 3),
    [ws],
  );
  const todayTasks = legacyTasks.length > 0 ? legacyTasks : workspaceTodayTasks;
  const tomorrowTasks = useMemo(() => getTomorrowTasksFromWorkspace(ws), [ws]);
  const doneCount = todayTasks.filter((task) => task.completed).length;
  const totalCount = todayTasks.length;
  const progress = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
  const hasPlans = ws.plans.length > 0 || ws.adhocTasks.length > 0;

  const toggleTask = (task: HomeTask) => {
    let nextTasks: HomeTask[];
    if (task.source === "legacy") {
      nextTasks = saveLegacyToggle(task.id);
      setLegacyTasks(nextTasks);
    } else {
      const completed = !task.completed;
      const nextWs = updateTaskEverywhere(task.id, {
        completed,
        focusSeconds: task.minutes * 60,
      });
      setWs(nextWs);
      nextTasks = getTodayTasksFromWorkspace(nextWs)
        .map(toHomeTaskFromWorkspace)
        .slice(0, 3);
    }
    if (nextTasks.length > 0 && nextTasks.every((item) => item.completed)) {
      setCelebrating(true);
      window.setTimeout(() => setCelebrating(false), 1800);
    }
  };

  return (
    <div className="bg-[#F7F3EB]">
      <section className="max-w-5xl mx-auto px-4 pt-8 pb-10">
        <div className="mb-5 flex items-center justify-between gap-4">
          <div>
            <div className="text-xs font-medium text-stone-400">{todayStr()}</div>
            <h1 className="mt-1 text-2xl font-bold text-stone-900">
              {greeting(doneCount, totalCount)}
            </h1>
          </div>
          <div className="shrink-0 rounded-full bg-white px-4 py-2 text-sm font-semibold text-brand-600 shadow-sm ring-1 ring-stone-100">
            🔥 连续{achievement.streakDays}天
          </div>
        </div>

        <div className="card overflow-hidden p-5">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <LogoMark variant="mark" className="h-8 w-8 text-brand-500" />
              <div>
                <h2 className="text-xl font-bold text-stone-900">今日3件事</h2>
                <p className="text-xs text-stone-400">打开就做，不用再找任务。</p>
              </div>
            </div>
            <Link to="/schedule" className="text-xs font-medium text-brand-600">
              学习日
            </Link>
          </div>

          {todayTasks.length > 0 ? (
            <div className="space-y-3">
              {todayTasks.map((task) => (
                <article
                  key={`${task.source}-${task.id}`}
                  className={`relative flex items-center gap-3 rounded-2xl border px-4 py-4 transition ${
                    task.completed
                      ? "border-stone-100 bg-stone-50 text-stone-400"
                      : "border-[#EDE6D8] bg-white text-stone-900 shadow-sm"
                  }`}
                >
                  {task.isYesterdayLeftover && (
                    <span className="absolute -top-2 left-4 rounded-full bg-rose-500 px-2 py-0.5 text-[10px] font-semibold text-white">
                      ⏰ 昨日未完成
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={task.completed ? "取消完成" : "标记完成"}
                    onClick={() => toggleTask(task)}
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 transition ${
                      task.completed
                        ? "border-emerald-500 bg-emerald-500 text-white"
                        : "border-stone-300 bg-white hover:border-brand-400"
                    }`}
                  >
                    {task.completed && (
                      <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                        <path
                          fillRule="evenodd"
                          d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 011.4-1.4l3.3 3.3 6.8-6.8a1 1 0 011.4 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                    )}
                  </button>
                  <div className="min-w-0 flex-1">
                    <h3
                      className={`text-base font-semibold leading-snug ${
                        task.completed ? "line-through" : ""
                      }`}
                    >
                      {task.title}
                    </h3>
                    <span className="mt-1 inline-flex rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-600">
                      {task.subject}
                    </span>
                  </div>
                  <div className="shrink-0 text-sm font-semibold text-stone-500">
                    {task.minutes}分钟
                  </div>
                </article>
              ))}
            </div>
          ) : hasPlans ? (
            <div className="rounded-2xl border border-dashed border-stone-200 bg-[#FBF9F4] px-5 py-10 text-center">
              <div className="text-3xl">😌</div>
              <h3 className="mt-3 font-semibold text-stone-900">今天可以休息</h3>
              <p className="mt-1 text-sm text-stone-500">当前计划今天没有任务，保持节奏就好。</p>
              <Link to="/schedule" className="btn-ghost mt-5 inline-flex">
                查看学习日
              </Link>
            </div>
          ) : (
            <Link
              to="/planner"
              className="block rounded-2xl border border-dashed border-brand-200 bg-brand-50/60 px-5 py-10 text-center transition hover:bg-brand-50"
            >
              <div className="text-3xl">🎯</div>
              <h3 className="mt-3 text-lg font-semibold text-stone-900">
                输入你的目标，AI帮你拆成每天的任务 →
              </h3>
              <p className="mt-1 text-sm text-stone-500">先从一个截止日期明确的大目标开始。</p>
            </Link>
          )}

          <div className="mt-5 rounded-2xl bg-[#FBF9F4] p-4">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="font-medium text-stone-700">
                {totalCount > 0 && doneCount === totalCount
                  ? "🎉 今天全部完成！"
                  : `今日完成 ${doneCount}/${totalCount || 3}`}
              </span>
              <span className="text-xs text-stone-400">{progress}%</span>
            </div>
            <div className="h-3 overflow-hidden rounded-full bg-[#EDE6D8]">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  totalCount > 0 && doneCount === totalCount
                    ? "bg-emerald-500"
                    : "bg-gradient-to-r from-sky-400 to-brand-500"
                }`}
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="mt-4 flex items-center justify-between gap-3">
              {celebrating && (
                <span className="text-sm font-semibold text-emerald-600 animate-pulse">
                  太棒了，今日清单完成！
                </span>
              )}
              <Link to="/progress" className="btn-ghost ml-auto py-2 text-sm">
                查看明日任务
                {tomorrowTasks.length > 0 ? ` · ${tomorrowTasks.length}项` : ""}
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-4 pb-16">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {FEATURES.map((f) => (
            <Link
              key={f.to}
              to={f.to}
              className="card p-4 hover:-translate-y-0.5 transition group"
            >
              <div
                className={`h-1 -mx-4 -mt-4 mb-3 rounded-t-2xl ${f.accent}`}
              />
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-stone-900">{f.title}</h3>
                {f.pro && <ProBadge />}
              </div>
              <div className="h-28 mb-3 rounded-xl bg-[#FBF9F4] p-3 flex items-center justify-center overflow-hidden">
                {f.preview}
              </div>
              <p className="text-xs text-stone-500">{f.desc}</p>
            </Link>
          ))}
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-4 pb-20">
        <h2 className="text-2xl font-bold text-stone-900 text-center mb-10">
          拆解 · 执行 · 沉淀 · 复习
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[
            { n: "01", t: "AI 拆解", d: "输入目标，生成每日任务" },
            { n: "02", t: "学习日", d: "大目标 + 临时任务，今天做啥" },
            { n: "03", t: "复盘洞察", d: "总结原因，未完成池自选" },
            { n: "04", t: "知识复习", d: "沉淀笔记，遗忘曲线提醒" },
          ].map((s) => (
            <div key={s.n} className="card p-5">
              <div className="text-xs font-mono text-brand-500 mb-2">
                {s.n}
              </div>
              <div className="font-semibold text-stone-900">{s.t}</div>
              <div className="text-sm text-stone-500 mt-1">{s.d}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-4 pb-20">
        <div className="rounded-3xl bg-brand-500 p-10 text-center text-white">
          <h2 className="text-2xl md:text-3xl font-bold">
            准备好开启你的下一段旅程了吗？
          </h2>
          <p className="mt-3 text-brand-100">
            不用再翻几十篇攻略，3 秒生成专属执行计划。
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link
              to="/planner"
              className="inline-flex items-center justify-center rounded-xl bg-white px-6 py-3 text-brand-600 font-semibold hover:bg-[#FBF9F4] transition"
            >
              拆解我的目标
            </Link>
            <Link
              to="/schedule"
              className="inline-flex items-center justify-center rounded-xl border border-white/40 px-6 py-3 text-white font-semibold hover:bg-white/10 transition"
            >
              进入学习日
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
