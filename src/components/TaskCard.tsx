import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { HelpMessage, Priority, ResourceItem, TaskAttemptInput, TaskItem } from "../types/plan";
import { PRIORITY_LABELS } from "../types/plan";
import { useTaskTimer, formatTime } from "../hooks/useTaskTimer";
import { normalizeSteps } from "../lib/stepGuide";
import { stripMarkdown } from "../lib/textSanitize";
import {
  askTaskHelp,
  bindTaskResource,
  listResources,
  requestTaskReview,
} from "../services/planApi";
import {
  appendTaskAiReview,
  getTimerSeconds,
  mergeServerTask,
  todayStr,
  uid,
} from "../lib/storage";

type Props = {
  task: TaskItem;
  onToggleComplete: (id: string) => void;
  onEdit: (id: string, patch: Partial<TaskItem>) => void;
  /** 学习日展示：所属目标名或「临时」 */
  goalLabel?: string;
};

const PRIORITY_STYLE: Record<string, string> = {
  high: "bg-rose-50 text-rose-600 border-rose-100",
  medium: "bg-amber-50 text-amber-700 border-amber-100",
  low: "bg-emerald-50 text-emerald-700 border-emerald-100",
};

const CHEER = [
  "漂亮，又迈出一步",
  "完成一项，节奏在线",
  "搞定！离目标更近了",
  "今天的自己值得夸",
];

const CYCLE: Priority[] = ["high", "medium", "low"];

export default function TaskCard({
  task,
  onToggleComplete,
  onEdit,
  goalLabel,
}: Props) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [minutesDraft, setMinutesDraft] = useState(
    String(task.suggestedMinutes)
  );
  const [mode, setMode] = useState<"countup" | "countdown">("countup");
  const [countdownMin, setCountdownMin] = useState(task.suggestedMinutes);
  const [cheer, setCheer] = useState<string | null>(null);
  const [pop, setPop] = useState(false);

  const [helpQ, setHelpQ] = useState("");
  const [helpAnswer, setHelpAnswer] = useState<string | null>(null);
  const [helpThreadId, setHelpThreadId] = useState<string | undefined>();
  const [helpMessages, setHelpMessages] = useState<HelpMessage[]>([]);
  const [helpLoading, setHelpLoading] = useState(false);
  const [helpError, setHelpError] = useState<string | null>(null);

  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewDone, setReviewDone] = useState(false);
  const [attempt, setAttempt] = useState<TaskAttemptInput>({
    totalQuestions: undefined,
    correctQuestions: undefined,
    wrongText: "",
    moduleData: {},
    lossReasons: [],
  });
  const [moduleName, setModuleName] = useState("");
  const [moduleTotal, setModuleTotal] = useState("");
  const [moduleCorrect, setModuleCorrect] = useState("");
  const [intervals, setIntervals] = useState<number[]>(task.reviewIntervals?.length ? task.reviewIntervals : [3, 7, 14, 30]);
  const [reminderTime, setReminderTime] = useState("20:00");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [resources, setResources] = useState<ResourceItem[]>([]);
  const [resourceError, setResourceError] = useState<string | null>(null);

  const timer = useTaskTimer(task.id, task.focusSeconds);

  const steps = useMemo(
    () =>
      normalizeSteps(task.steps, {
        title: task.title,
        suggestedMinutes: task.suggestedMinutes,
        goalTitle: goalLabel && goalLabel !== "临时" ? goalLabel : undefined,
      }),
    [task.steps, task.title, task.suggestedMinutes, goalLabel]
  );

  useEffect(() => {
    if (!cheer) return;
    const t = setTimeout(() => setCheer(null), 1800);
    return () => clearTimeout(t);
  }, [cheer]);

  const handleStart = () => {
    if (mode === "countdown") {
      timer.start(countdownMin * 60);
    } else {
      timer.start(null);
    }
  };

  const handleSaveEdit = () => {
    const mins = Number(minutesDraft);
    if (!Number.isNaN(mins) && mins > 0) {
      onEdit(task.id, {
        title: titleDraft.trim() || task.title,
        suggestedMinutes: mins,
      });
      setCountdownMin(mins);
    }
    setEditing(false);
  };

  const cyclePriority = () => {
    const idx = CYCLE.indexOf(task.priority);
    const next = CYCLE[(idx + 1) % CYCLE.length];
    onEdit(task.id, { priority: next });
  };

  const handleToggle = () => {
    const becomingDone = !task.completed;
    onToggleComplete(task.id);
    if (becomingDone) {
      setPop(true);
      setCheer(CHEER[Math.floor(Math.random() * CHEER.length)]);
      window.setTimeout(() => setPop(false), 220);
    } else {
      setReviewDone(false);
    }
  };

  const handleAskAi = async () => {
    const q = helpQ.trim();
    if (!q) {
      setHelpError("先写一句你卡住的地方");
      return;
    }
    setHelpError(null);
    setHelpLoading(true);
    try {
      const res = await askTaskHelp({
        question: q,
        taskId: task.id,
        threadId: helpThreadId,
        history: helpMessages,
        goalTitle: goalLabel,
        task: {
          title: task.title,
          description: task.description,
          steps: task.steps,
          checkCriteria: task.checkCriteria,
          suggestedMinutes: task.suggestedMinutes,
        },
      });
      setHelpAnswer(res.answer ?? "");
      setHelpThreadId(res.threadId ?? helpThreadId);
      setHelpMessages((previous) => [
        ...previous,
        { role: "user", content: q },
        { role: "assistant", content: res.answer ?? "" },
      ]);
      setHelpQ("");
    } catch (e) {
      setHelpError(e instanceof Error ? e.message : "提问失败");
    } finally {
      setHelpLoading(false);
    }
  };

  const openResources = async () => {
    setResourcesOpen((value) => !value);
    if (resources.length) return;
    setResourceError(null);
    try {
      const result = await listResources();
      setResources(result.resources ?? []);
    } catch (error) {
      console.error("任务卡加载知识库失败", error);
      setResourceError(error instanceof Error ? error.message : "知识库加载失败");
    }
  };

  const bindResource = async (resourceId: string) => {
    setResourceError(null);
    try {
      await bindTaskResource(task.id, resourceId);
      onEdit(task.id, { resources: [...new Set([...(task.resources ?? []), resourceId])] });
    } catch (error) {
      console.error("任务资料绑定失败", error);
      setResourceError(error instanceof Error ? error.message : "绑定失败");
    }
  };

  const handleAiReview = async () => {
    if (!task.completed) return;
    setReviewError(null);
    setReviewLoading(true);
    try {
      const focusSeconds = Math.max(
        task.focusSeconds || 0,
        getTimerSeconds(task.id),
        timer.elapsed
      );
      const res = await requestTaskReview({
        task: {
          id: task.id,
          title: task.title,
          description: task.description,
          steps: task.steps,
          checkCriteria: task.checkCriteria,
          suggestedMinutes: task.suggestedMinutes,
          focusSeconds,
          priority: task.priority,
          topicTags: task.topicTags,
        },
        goalTitle: goalLabel,
        goalId: task.goalId,
        focusSeconds,
        attempt,
        reviewIntervals: intervals,
        reminderTime,
      });
      for (const reinforcement of res.reinforcementTasks ?? []) {
        mergeServerTask({
          id: reinforcement.taskId,
          goalId: task.goalId,
          date: reinforcement.scheduledDate,
          title: reinforcement.title,
          description: reinforcement.reason,
          steps: ["回看本次错题与复盘报告", "针对薄弱点完成补强练习", "重新自测并记录结果"],
          checkCriteria: "补强练习正确率达到 80%，并能说明原失分原因",
          priority: "high",
          completed: false,
          focusSeconds: 0,
          source: task.goalId ? "goal" : "adhoc",
          suggestedMinutes: Number(reinforcement.suggestedMinutes) || 20,
          reviewIntervals: intervals,
        });
      }
      appendTaskAiReview({
        id: uid(),
        taskId: task.id,
        taskTitle: task.title,
        goalTitle: goalLabel,
        report: res.report ?? "",
        focusSeconds,
        suggestedMinutes: task.suggestedMinutes,
        checkCriteria: task.checkCriteria,
        date: todayStr(),
        createdAt: new Date().toISOString(),
      });
      setReviewDone(true);
      navigate("/progress", { state: { fromTaskReview: true, taskId: task.id } });
    } catch (e) {
      setReviewError(e instanceof Error ? e.message : "复盘失败");
    } finally {
      setReviewLoading(false);
    }
  };

  const addModuleResult = () => {
    const name = moduleName.trim();
    const total = Number(moduleTotal);
    const correct = Number(moduleCorrect);
    if (
      !name ||
      !Number.isInteger(total) ||
      !Number.isInteger(correct) ||
      total < 0 ||
      correct < 0 ||
      correct > total
    ) {
      setReviewError("模块统计需填写模块名，且正确数不能大于总数");
      return;
    }
    setAttempt((value) => ({
      ...value,
      moduleData: {
        ...(value.moduleData ?? {}),
        [name]: { total, correct },
      },
    }));
    setModuleName("");
    setModuleTotal("");
    setModuleCorrect("");
    setReviewError(null);
  };

  return (
    <div
      className={`card p-4 transition ${
        task.completed ? "opacity-95" : ""
      } ${pop ? "scale-[1.02]" : "scale-100"}`}
    >
      <div className="flex items-start gap-3">
        <button
          onClick={handleToggle}
          className={`mt-1 w-5 h-5 rounded-md border-2 flex items-center justify-center transition ${
            task.completed
              ? "bg-emerald-500 border-emerald-500 text-white"
              : "border-slate-300 hover:border-brand-400"
          }`}
          aria-label={task.completed ? "取消完成" : "标记完成"}
        >
          {task.completed && (
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3">
              <path
                fillRule="evenodd"
                d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 011.4-1.4l3.3 3.3 6.8-6.8a1 1 0 011.4 0z"
                clipRule="evenodd"
              />
            </svg>
          )}
        </button>

        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="space-y-2">
              <input
                className="input-field text-sm"
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
              />
              <div className="flex items-center gap-2">
                <label className="text-xs text-slate-500">建议分钟</label>
                <input
                  type="number"
                  min={1}
                  className="input-field text-sm w-24"
                  value={minutesDraft}
                  onChange={(e) => setMinutesDraft(e.target.value)}
                />
                <button
                  className="btn-primary text-sm py-1.5"
                  onClick={handleSaveEdit}
                >
                  保存
                </button>
                <button
                  className="btn-ghost text-sm py-1.5"
                  onClick={() => setEditing(false)}
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <h3
                  className={`font-medium text-slate-900 line-clamp-2 ${
                    task.completed ? "line-through" : ""
                  }`}
                >
                  {stripMarkdown(task.title)}
                </h3>
                {goalLabel !== undefined && (
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full ${
                      task.source === "adhoc" || !task.goalId
                        ? "bg-slate-100 text-slate-600"
                        : "bg-brand-50 text-brand-600"
                    }`}
                  >
                    {goalLabel || "临时"}
                  </span>
                )}
                {task.subject && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-sky-50 text-sky-700">
                    {stripMarkdown(task.subject)}
                  </span>
                )}
                {task.fromBacklog && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-600">
                    补做
                  </span>
                )}
                <button
                  type="button"
                  onClick={cyclePriority}
                  title="点击切换优先级"
                  className={`text-xs px-2 py-0.5 rounded-full border ${
                    PRIORITY_STYLE[task.priority] ?? PRIORITY_STYLE.low
                  }`}
                >
                  优先·{PRIORITY_LABELS[task.priority] ?? "低"}
                </button>
                <button
                  className="text-xs text-slate-400 hover:text-brand-500"
                  onClick={() => setEditing(true)}
                >
                  编辑
                </button>
              </div>
              {cheer && (
                <p className="text-xs text-emerald-600 mt-1.5 font-medium">
                  {cheer}
                </p>
              )}
              {task.description && (
                <p className="text-sm text-slate-600 mt-1.5 line-clamp-2">
                  {stripMarkdown(task.description)}
                </p>
              )}
              {steps.length > 0 && (
                <ol className="mt-2.5 space-y-2.5">
                  {steps.map((step, idx) => (
                    <li
                      key={idx}
                      className="flex items-start gap-2 text-sm text-slate-700"
                    >
                      <span className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full bg-brand-50 text-brand-600 text-[11px] font-semibold mt-0.5">
                        {idx + 1}
                      </span>
                      <div className="min-w-0 leading-relaxed">
                        <div className="font-medium text-slate-800">
                          {step.action}
                        </div>
                        {(step.goal || step.minutes) && (
                          <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-stone-500">
                            {step.goal && (
                              <span>
                                <strong className="text-stone-600">目标：</strong>
                                {step.goal}
                              </span>
                            )}
                            {step.minutes && (
                              <span className="rounded-full bg-stone-100 px-2 py-0.5">
                                预计 {step.minutes} 分钟
                              </span>
                            )}
                          </div>
                        )}
                        {step.guide && (
                          <p className="mt-1 text-xs text-slate-500">
                            <span className="text-slate-600">操作指引：</span>
                            {step.guide}
                          </p>
                        )}
                        {step.microActions?.length ? (
                          <div className="mt-2 rounded-lg border border-stone-100 bg-stone-50 px-2.5 py-2">
                            <div className="text-[11px] font-semibold text-stone-600 mb-1">
                              微动作清单
                            </div>
                            <ul className="space-y-1.5">
                              {step.microActions.map((item, actionIndex) => (
                                <li key={`${idx}-${actionIndex}`} className="text-xs text-stone-600">
                                  <label className="flex items-start gap-1.5">
                                    <input type="checkbox" className="mt-0.5" />
                                    <span>
                                      {item.text}
                                      {(item.material || item.sourceRef || item.timeLimit) && (
                                        <span className="block text-[11px] text-stone-400">
                                          {[item.material, item.sourceRef, item.timeLimit]
                                            .filter(Boolean)
                                            .join(" · ")}
                                        </span>
                                      )}
                                    </span>
                                  </label>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        {step.checkCriteria && (
                          <p className="mt-1.5 text-xs font-medium text-stone-700">
                            <span className="text-brand-700">本步自检：</span>
                            {step.checkCriteria}
                          </p>
                        )}
                        {step.blockers?.length ? (
                          <div className="mt-2 rounded-lg bg-amber-50 px-2.5 py-2 text-xs text-amber-900">
                            <div className="font-semibold mb-1">常见卡点 & 解法</div>
                            <ul className="space-y-1">
                              {step.blockers.map((blocker, blockerIndex) => (
                                <li key={`${idx}-blocker-${blockerIndex}`}>
                                  <strong>{blocker.problem}：</strong>
                                  {blocker.solution}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
              {task.checkCriteria && (
                <div className="mt-2.5 rounded-lg bg-[#FBF1EC] border border-[#ECC0AD] px-3 py-2">
                  <div className="text-[11px] font-semibold text-brand-700 mb-0.5">
                    自检标准
                  </div>
                  <p className="text-sm font-bold text-stone-900 leading-relaxed">
                    {stripMarkdown(task.checkCriteria)}
                  </p>
                </div>
              )}
              {(task.topicTags?.length || task.priorityReason || task.sourceReason || task.resourceSuggestions?.length) && (
                <div className="mt-2">
                  <button className="text-xs font-medium text-brand-600" onClick={() => setDetailsOpen((value) => !value)}>
                    {detailsOpen ? "收起实操详情" : "展开实操详情"}
                  </button>
                  {detailsOpen && (
                    <div className="mt-2 rounded-lg border border-[#EDE6D8] bg-[#FBF9F4] px-3 py-2 text-xs text-stone-600 space-y-1">
                      {task.sourceReason && <p><strong>来源：</strong>{task.sourceReason}</p>}
                      {task.priorityReason && <p><strong>优先理由：</strong>{task.priorityReason}</p>}
                      {task.topicTags?.length ? <p><strong>知识点：</strong>{task.topicTags.join("、")}</p> : null}
                      {task.resourceSuggestions?.length ? <p><strong>资料建议：</strong>{task.resourceSuggestions.join("；")}</p> : null}
                    </div>
                  )}
                </div>
              )}
              <div className="text-xs text-slate-400 mt-2">
                建议 {task.suggestedMinutes} 分钟
              </div>
            </>
          )}
        </div>

        <div className="text-right shrink-0">
          <div className="font-mono text-2xl font-semibold text-brand-600 tabular-nums">
            {formatTime(timer.displaySeconds ?? timer.elapsed)}
          </div>
          <div className="text-xs text-slate-400">
            {timer.state === "running"
              ? timer.target !== null
                ? "倒计时中"
                : "专注中"
              : timer.state === "paused"
              ? "已暂停"
              : timer.state === "done"
              ? "已完成"
              : "未开始"}
          </div>
        </div>
      </div>

      {/* 计时栏：未完成时保留 */}
      {!task.completed && (
        <div className="mt-3 pt-3 border-t border-slate-100 flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden text-xs">
            <button
              className={`px-3 py-1.5 ${
                mode === "countup"
                  ? "bg-brand-500 text-white"
                  : "bg-white text-slate-600"
              }`}
              onClick={() => setMode("countup")}
            >
              正计时
            </button>
            <button
              className={`px-3 py-1.5 ${
                mode === "countdown"
                  ? "bg-brand-500 text-white"
                  : "bg-white text-slate-600"
              }`}
              onClick={() => setMode("countdown")}
            >
              倒计时
            </button>
          </div>
          {mode === "countdown" && (
            <input
              type="number"
              min={1}
              value={countdownMin}
              onChange={(e) =>
                setCountdownMin(Number(e.target.value) || 1)
              }
              className="input-field text-sm w-24 py-1.5"
            />
          )}
          {timer.state === "idle" && (
            <button className="btn-primary text-sm py-1.5" onClick={handleStart}>
              开始专注
            </button>
          )}
          {timer.state === "running" && (
            <button className="btn-ghost text-sm py-1.5" onClick={timer.pause}>
              暂停
            </button>
          )}
          {timer.state === "paused" && (
            <button
              className="btn-primary text-sm py-1.5"
              onClick={timer.resume}
            >
              继续
            </button>
          )}
          {timer.state !== "idle" && (
            <button
              className="text-sm text-slate-400 hover:text-rose-500"
              onClick={timer.stop}
            >
              重置
            </button>
          )}
        </div>
      )}

      {/* 问 AI：固定在卡片底部 */}
      <div className="mt-3 pt-3 border-t border-slate-100">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="text-xs font-semibold text-stone-700">这里操作不会？问AI</div>
          <button className="text-xs text-brand-600" onClick={() => void openResources()}>绑定资料</button>
        </div>
        {resourcesOpen && (
          <div className="mb-2 max-h-36 overflow-y-auto rounded-lg border border-stone-100 bg-stone-50 p-2">
            {resources.length === 0 ? (
              <p className="text-xs text-stone-400">知识库暂无资源，请先去知识库新增。</p>
            ) : resources.map((resource) => (
              <div key={resource.id} className="flex items-center justify-between gap-2 py-1 text-xs">
                <a
                  href={resource.kind === "link" && resource.sourceUrl
                    ? resource.sourceUrl
                    : resource.kind === "pdf" || resource.kind === "file"
                      ? `/api/resources?id=${encodeURIComponent(resource.id)}&download=1`
                      : "/knowledge"}
                  target={resource.kind === "note" ? undefined : "_blank"}
                  rel="noreferrer"
                  className="truncate text-stone-700 hover:text-brand-600"
                >
                  {resource.title}
                </a>
                <button className="text-brand-600 shrink-0" onClick={() => void bindResource(resource.id)}>
                  {(task.resources ?? []).includes(resource.id) ? "已绑定" : "绑定"}
                </button>
              </div>
            ))}
            {resourceError && <p className="text-xs text-rose-600">{resourceError}</p>}
          </div>
        )}
        <div className="flex gap-2">
          <input
            className="input-field text-sm py-2 flex-1"
            placeholder="例如：第一步找不到材料怎么办？"
            value={helpQ}
            onChange={(e) => setHelpQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleAskAi();
              }
            }}
          />
          <button
            type="button"
            className="btn-primary text-sm py-2 px-4 shrink-0"
            disabled={helpLoading}
            onClick={() => void handleAskAi()}
          >
            {helpLoading ? "…" : "发送"}
          </button>
        </div>
        {helpError && (
          <p className="mt-2 text-xs text-rose-600">{helpError}</p>
        )}
        {helpMessages.length > 0 ? (
          <div className="mt-2 max-h-52 overflow-y-auto space-y-2">
            {helpMessages.map((message, index) => (
              <div key={`${message.role}-${index}`} className={`rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${message.role === "user" ? "ml-8 bg-[#FBF1EC] text-stone-800" : "mr-8 bg-stone-50 text-stone-700"}`}>
                {message.content ?? ""}
              </div>
            ))}
          </div>
        ) : helpAnswer ? (
          <div className="mt-2 rounded-lg bg-stone-50 border border-stone-100 px-3 py-2 text-sm text-stone-700 whitespace-pre-wrap">{helpAnswer}</div>
        ) : null}
      </div>

      {/* 一键 AI 复盘：仅完成解锁 */}
      <div className="mt-3">
        {task.completed && (
          <div className="mb-3 rounded-xl border border-[#EDE6D8] bg-[#FBF9F4] p-3">
            <div className="text-xs font-semibold text-stone-700 mb-2">完成数据（填写题目统计或错题记录）</div>
            <div className="grid grid-cols-2 gap-2">
              <input className="input-field py-2 text-sm" type="number" min={0} placeholder="总题数" value={attempt.totalQuestions ?? ""} onChange={(event) => setAttempt((value) => ({ ...value, totalQuestions: event.target.value === "" ? undefined : Number(event.target.value) }))} />
              <input className="input-field py-2 text-sm" type="number" min={0} placeholder="正确数" value={attempt.correctQuestions ?? ""} onChange={(event) => setAttempt((value) => ({ ...value, correctQuestions: event.target.value === "" ? undefined : Number(event.target.value) }))} />
            </div>
            <textarea className="input-field mt-2 min-h-[64px] py-2 text-sm" placeholder="错题文本 / 错题记录" value={attempt.wrongText ?? ""} onChange={(event) => setAttempt((value) => ({ ...value, wrongText: event.target.value }))} />
            <div className="mt-2 rounded-lg border border-stone-200 bg-white p-2">
              <div className="text-xs font-medium text-stone-600">模块统计</div>
              <div className="mt-2 grid grid-cols-[1fr_72px_72px_auto] gap-1.5">
                <input className="input-field py-1.5 text-xs" placeholder="模块名" value={moduleName} onChange={(event) => setModuleName(event.target.value)} />
                <input className="input-field py-1.5 text-xs" type="number" min={0} placeholder="总数" value={moduleTotal} onChange={(event) => setModuleTotal(event.target.value)} />
                <input className="input-field py-1.5 text-xs" type="number" min={0} placeholder="正确" value={moduleCorrect} onChange={(event) => setModuleCorrect(event.target.value)} />
                <button type="button" className="btn-ghost px-2 py-1.5 text-xs" onClick={addModuleResult}>添加</button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {Object.entries(attempt.moduleData ?? {}).map(([name, data]) => (
                  <button
                    type="button"
                    key={name}
                    title="点击删除"
                    className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] text-stone-600"
                    onClick={() => setAttempt((value) => {
                      const next = { ...(value.moduleData ?? {}) };
                      delete next[name];
                      return { ...value, moduleData: next };
                    })}
                  >
                    {name} {Number(data.correct)}/{Number(data.total)} ×
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-stone-600">
              <strong>失分原因：</strong>
              {["概念不清", "审题偏差", "步骤遗漏", "计算失误", "时间不足"].map((reason) => (
                <label key={reason} className="inline-flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={(attempt.lossReasons ?? []).includes(reason)}
                    onChange={() => setAttempt((value) => ({
                      ...value,
                      lossReasons: (value.lossReasons ?? []).includes(reason)
                        ? (value.lossReasons ?? []).filter((item) => item !== reason)
                        : [...(value.lossReasons ?? []), reason],
                    }))}
                  />
                  {reason}
                </label>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-600">
              <strong>复习周期：</strong>
              {[3, 7, 14, 30].map((day) => (
                <label key={day} className="inline-flex items-center gap-1">
                  <input type="checkbox" checked={intervals.includes(day)} onChange={() => setIntervals((value) => value.includes(day) ? value.filter((item) => item !== day) : [...value, day].sort((a, b) => a - b))} />
                  {day} 天
                </label>
              ))}
              <label className="ml-auto inline-flex items-center gap-1">
                提醒
                <input
                  className="rounded-md border border-stone-200 bg-white px-1.5 py-1"
                  type="time"
                  value={reminderTime}
                  onChange={(event) => setReminderTime(event.target.value || "20:00")}
                />
              </label>
            </div>
          </div>
        )}
        <button
          type="button"
          className={`w-full rounded-xl px-4 py-2.5 text-sm font-semibold transition ${
            task.completed
              ? "bg-[#D95427] text-white hover:bg-[#C0451F]"
              : "bg-stone-100 text-stone-400 cursor-not-allowed"
          }`}
          disabled={!task.completed || reviewLoading || intervals.length === 0 || (!(Number(attempt.totalQuestions) > 0) && !attempt.wrongText?.trim())}
          onClick={() => void handleAiReview()}
          title={
            task.completed ? "填写题目统计或错题记录后生成复盘" : "勾选完成任务后解锁"
          }
        >
          {reviewLoading
            ? "生成复盘中…"
            : reviewDone
            ? "已生成 · 再生成一次"
            : "一键AI复盘"}
        </button>
        {!task.completed && (
          <p className="mt-1 text-[11px] text-stone-400 text-center">
            勾选完成任务后解锁
          </p>
        )}
        {reviewError && (
          <p className="mt-1 text-xs text-rose-600 text-center">{reviewError}</p>
        )}
      </div>
    </div>
  );
}
