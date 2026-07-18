import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { syncDevProEntitlement } from "../services/planApi";
import {
  configureProEntitlement,
  getTrialInfo,
  isProUnlocked,
  setProUnlocked,
} from "../lib/storage";

const PLANS = [
  {
    id: "monthly",
    name: "月度",
    price: 19,
    per: "月",
    note: "灵活体验",
    highlight: false,
  },
  {
    id: "quarterly",
    name: "季度",
    price: 49,
    per: "季",
    note: "约 ¥16/月 · 推荐给学生",
    highlight: true,
  },
  {
    id: "yearly",
    name: "年度",
    price: 168,
    per: "年",
    note: "约 ¥14/月 · 最优惠",
    highlight: false,
  },
];

const COMPARE = [
  { feature: "进行中目标数", free: "1 个", pro: "无限" },
  { feature: "AI 拆解次数", free: "每天 3 次", pro: "无限" },
  { feature: "AI 重排次数", free: "每天 1 次", pro: "无限" },
  { feature: "历史记录保留", free: "7 天", pro: "完整 + 导出" },
  { feature: "计时模式", free: "基础正/倒计时", pro: "番茄 + 自定义" },
  { feature: "成就系统", free: "基础徽章", pro: "完整 + 数据看板" },
  { feature: "个人知识库", free: "只读", pro: "完整功能" },
  { feature: "复习提醒", free: "站内", pro: "邮件 + 推送" },
  { feature: "AI 模型", free: "轻量", pro: "升级模型" },
];

export default function MembershipPage() {
  const development = import.meta.env.DEV;
  const [pro, setPro] = useState<boolean>(() => development && isProUnlocked());
  const [trial, setTrial] = useState(() => getTrialInfo());
  const [pickedPlan, setPickedPlan] = useState<string>("quarterly");
  const [showTrial, setShowTrial] = useState(false);

  useEffect(() => {
    const loadEntitlement = async () => {
      try {
        const response = await fetch("/api/workspace");
        if (!response.ok) throw new Error(`权益读取失败 (${response.status})`);
        const data = (await response.json()) as { entitlement?: { pro?: boolean } };
        if (!development) setPro(Boolean(data.entitlement?.pro));
      } catch (error) {
        console.error("服务端会员权益读取失败，生产按免费版降级", error);
        if (!development) setPro(false);
      }
    };
    void loadEntitlement();
  }, [development]);

  const handleUnlock = async () => {
    if (!development) return;
    try {
      setProUnlocked(true);
      const result = await syncDevProEntitlement(true);
      configureProEntitlement(Boolean(result.entitlement?.pro));
      setPro(true);
      setTrial(getTrialInfo());
      setShowTrial(true);
    } catch (error) {
      console.error("本地 Pro 同步到服务端失败", error);
      setProUnlocked(false);
      setPro(false);
      alert(error instanceof Error ? error.message : "Pro 解锁同步失败，请重试");
    }
  };

  const handleDowngrade = async () => {
    if (!development) return;
    try {
      setProUnlocked(false);
      const result = await syncDevProEntitlement(false);
      configureProEntitlement(Boolean(result.entitlement?.pro));
      setPro(false);
      setTrial({ active: false, daysRemaining: 0 });
    } catch (error) {
      console.error("本地 Pro 降级同步失败", error);
      alert(error instanceof Error ? error.message : "Pro 降级同步失败，请重试");
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-10">
      <div className="text-center mb-10">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-50 text-amber-600 text-xs font-medium mb-3">
          StepUp Pro
        </div>
        <h1 className="text-3xl md:text-4xl font-bold text-slate-900">
          解锁完整闭环，让坚持更高效
        </h1>
        <p className="mt-3 text-slate-600">
          7 天免费试用 · 到期自动降级 · 不自动扣费
        </p>
      </div>

      {/* 定价 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-10">
        {PLANS.map((p) => (
          <button
            key={p.id}
            onClick={() => setPickedPlan(p.id)}
            className={`relative text-left card p-6 transition ${
              pickedPlan === p.id
                ? "ring-2 ring-amber-400 shadow-md"
                : "hover:shadow-md"
            }`}
          >
            {p.highlight && (
              <span className="absolute -top-3 right-4 px-2 py-0.5 rounded-full bg-amber-400 text-white text-xs font-semibold">
                推荐
              </span>
            )}
            <div className="text-sm text-slate-500">{p.name}</div>
            <div className="flex items-baseline gap-1 mt-1">
              <span className="text-3xl font-bold text-slate-900">
                ¥{p.price}
              </span>
              <span className="text-sm text-slate-400">/ {p.per}</span>
            </div>
            <div className="text-xs text-slate-500 mt-2">{p.note}</div>
            <div className="mt-4">
              {pickedPlan === p.id ? (
                <span className="inline-flex items-center gap-1 text-sm text-amber-600 font-medium">
                  ✓ 已选择
                </span>
              ) : (
                <span className="text-sm text-slate-400">点击选择</span>
              )}
            </div>
          </button>
        ))}
      </div>

      {/* 解锁按钮 */}
      <div className="text-center mb-10">
        {pro ? (
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-50 text-emerald-600 text-sm font-medium">
              ✓ Pro 已开通 · 试用剩 {trial.daysRemaining} 天
            </div>
            <div>
              <button
                onClick={() => void handleDowngrade()}
                className="text-sm text-slate-400 hover:text-rose-500"
              >
                取消试用，恢复免费版
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => void handleUnlock()}
            disabled={!development}
            className="inline-flex items-center justify-center rounded-xl bg-brand-500 px-8 py-3 text-white font-semibold shadow-md shadow-brand-500/25 hover:bg-brand-600 transition"
          >
            {development ? "开发模式解锁 Pro · 7 天试用" : "支付未接入 · 联系管理员开通"}
          </button>
        )}
        <p className="text-xs text-slate-400 mt-3">
          {development
            ? "仅本地开发模式可模拟解锁；生产权限只认服务端 user_entitlements。"
            : "生产权限由服务端 user_entitlements 判定，不读取 localStorage 演示状态。"}
        </p>
      </div>

      {/* 功能对比 */}
      <div className="card overflow-hidden">
        <div className="grid grid-cols-3 bg-slate-50 px-5 py-3 text-sm font-medium text-slate-700">
          <div>功能</div>
          <div className="text-center">免费版</div>
          <div className="text-center text-amber-600">Pro 会员</div>
        </div>
        {COMPARE.map((row, i) => (
          <div
            key={row.feature}
            className={`grid grid-cols-3 px-5 py-3 text-sm ${
              i % 2 === 0 ? "bg-white" : "bg-slate-50/50"
            }`}
          >
            <div className="text-slate-700">{row.feature}</div>
            <div className="text-center text-slate-500">{row.free}</div>
            <div className="text-center text-amber-600 font-medium">
              {row.pro}
            </div>
          </div>
        ))}
      </div>

      {showTrial && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={() => setShowTrial(false)}
        >
          <div
            className="card p-6 max-w-sm text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-3xl mb-2">🎉</div>
            <h3 className="font-semibold text-slate-900 mb-1">
              Pro 已解锁
            </h3>
            <p className="text-sm text-slate-500">
              7 天免费试用已开启，所有 Pro 功能可立即体验。到期后自动降级，不会扣费。
            </p>
            <div className="mt-4 flex gap-2 justify-center">
              <Link to="/planner" className="btn-primary">
                去试试
              </Link>
              <button
                className="btn-ghost"
                onClick={() => setShowTrial(false)}
              >
                稍后
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
