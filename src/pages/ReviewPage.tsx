import { useEffect, useState } from "react";
import type { ReviewScheduleItem } from "../types/plan";
import { addReviewToToday, listDueReviews, submitReviewFeedback } from "../services/planApi";
import ProBadge from "../components/ProBadge";
import { mergeServerTask } from "../lib/storage";

const CURVE = [100, 72, 54, 42, 34, 29];

export default function ReviewPage() {
  const [items, setItems] = useState<ReviewScheduleItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pro, setPro] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listDueReviews();
      setItems(data.schedules ?? []);
      setPro(Boolean(data.entitlement?.pro));
    } catch (loadError) {
      console.error("到期复习队列加载失败", loadError);
      setError(loadError instanceof Error ? loadError.message : "复习队列加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const feedback = async (id: string, result: "remember" | "fuzzy" | "forgot") => {
    setError(null);
    try {
      const response = await submitReviewFeedback(id, result);
      setNotice(response.algorithm ?? "复习结果已记录");
      setItems((previous) => previous.filter((item) => item.id !== id));
    } catch (feedbackError) {
      console.error("复习反馈保存失败", feedbackError);
      setError(feedbackError instanceof Error ? feedbackError.message : "反馈保存失败");
    }
  };

  const addToday = async (id: string) => {
    setError(null);
    try {
      const result = await addReviewToToday(id);
      mergeServerTask(result.task);
      setNotice("已写入今天的学习任务");
    } catch (addError) {
      console.error("复习任务写入学习日失败", addError);
      setError(addError instanceof Error ? addError.message : "写入学习日失败");
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-stone-900">复习提醒</h1>
            <ProBadge />
          </div>
          <p className="text-sm text-stone-500 mt-1">真实读取到期计划；反馈会确定性调整下一次日期。</p>
        </div>
        <span className="text-xs text-stone-500">{pro ? "Pro · 批量提醒" : "免费版 · 站内提醒"}</span>
      </div>

      <div className="card p-5 mb-6">
        <h2 className="font-semibold text-stone-900">3 / 7 / 14 / 30 天复习节奏</h2>
        <p className="mt-1 text-xs text-stone-500">记得：进入下一周期；模糊：当前周期减半；忘了：次日重启。</p>
        <svg viewBox="0 0 320 110" className="mt-3 h-28 w-full" aria-label="记忆保持率示意">
          <line x1="20" y1="90" x2="310" y2="90" stroke="#e7dfd0" />
          <polyline points={CURVE.map((value, index) => `${20 + index * 58},${90 - value * 0.72}`).join(" ")} fill="none" stroke="#D95427" strokeWidth="3" />
          {CURVE.map((value, index) => <circle key={value} cx={20 + index * 58} cy={90 - value * 0.72} r="4" fill="#D95427" />)}
        </svg>
      </div>

      {error && <div className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}
      {notice && <div className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold text-stone-900">今日到期</h2>
        <span className="text-xs text-stone-500">{items.length} 条</span>
      </div>
      {loading ? (
        <p className="py-8 text-center text-sm text-stone-500">读取中…</p>
      ) : items.length === 0 ? (
        <div className="card p-8 text-center text-sm text-stone-500">今天没有到期复习，按计划继续推进即可。</div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <article key={item.id} className="card p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="font-medium text-stone-900">{item.title}</h3>
                  <p className="mt-1 text-xs text-stone-400">到期 {new Date(item.dueAt).toLocaleString()} · 提醒 {item.reminderTime}</p>
                  <button className="mt-2 text-xs text-brand-600" onClick={() => void addToday(item.id)}>写入学习日</button>
                </div>
                <div className="flex gap-1.5">
                  <button className="rounded-lg bg-emerald-50 px-3 py-1.5 text-xs text-emerald-700" onClick={() => void feedback(item.id, "remember")}>记得</button>
                  <button className="rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-700" onClick={() => void feedback(item.id, "fuzzy")}>模糊</button>
                  <button className="rounded-lg bg-rose-50 px-3 py-1.5 text-xs text-rose-700" onClick={() => void feedback(item.id, "forgot")}>忘了</button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      <p className="mt-5 text-xs text-stone-400">
        邮件与浏览器推送属于 Pro 能力，但当前未配置外部 provider；系统不会伪装已发送。
      </p>
    </div>
  );
}
