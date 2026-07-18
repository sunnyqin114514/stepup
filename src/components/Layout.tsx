import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { isProUnlocked, isTesterModeEnabled } from "../lib/storage";
import LogoMark from "./LogoMark";
import AuthDialog from "./AuthDialog";
import { useAuth } from "../auth/AuthContext";

const NAV = [
  { to: "/", label: "首页" },
  { to: "/schedule", label: "学习日" },
  { to: "/planner", label: "目标规划" },
  { to: "/progress", label: "复盘" },
  { to: "/knowledge", label: "知识库" },
  { to: "/review", label: "复习提醒" },
];

export default function Layout() {
  const location = useLocation();
  const { user, loading, error: authError, logoutUser, retryMigration } = useAuth();
  const [pro, setPro] = useState<boolean>(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [dueCount, setDueCount] = useState(0);
  const [testerModeVersion, setTesterModeVersion] = useState(0);
  const testerHeaders: HeadersInit = isTesterModeEnabled()
    ? { "X-StepUp-Tester-Mode": "true" }
    : {};

  useEffect(() => {
    const refreshTesterMode = () => setTesterModeVersion((version) => version + 1);
    window.addEventListener("stepup:tester-mode-change", refreshTesterMode);
    return () => window.removeEventListener("stepup:tester-mode-change", refreshTesterMode);
  }, []);

  useEffect(() => {
    if (!user && !import.meta.env.DEV) return;
    if (import.meta.env.DEV || isTesterModeEnabled()) setPro(isProUnlocked());
    const loadDueCount = async () => {
      try {
        const response = await fetch("/api/reviews", { headers: testerHeaders });
        if (!response.ok) throw new Error(`复习数量读取失败 (${response.status})`);
        const data = (await response.json()) as { dueCount?: number };
        setDueCount(Number(data.dueCount) || 0);
        if (!import.meta.env.DEV) {
          const entitlementResponse = await fetch("/api/workspace", { headers: testerHeaders });
          if (!entitlementResponse.ok) throw new Error(`权益读取失败 (${entitlementResponse.status})`);
          const entitlementData = (await entitlementResponse.json()) as { entitlement?: { pro?: boolean } };
          setPro(Boolean(entitlementData.entitlement?.pro));
        }
      } catch (error) {
        console.error("复习提醒数量读取失败，导航降级为不显示角标", error);
        setDueCount(0);
      }
    };
    void loadDueCount();
  }, [location.pathname, user, testerModeVersion]);

  if (loading) {
    return <div className="min-h-full bg-[#F7F3EB] p-10 text-center text-sm text-stone-500">正在确认登录状态…</div>;
  }

  if (!user && !import.meta.env.DEV) {
    return (
      <div className="min-h-full bg-[#F7F3EB] px-4 py-16">
        <div className="card mx-auto max-w-md p-8 text-center">
          <LogoMark variant="mark" className="mx-auto h-12 w-12 text-brand-600" />
          <h1 className="mt-4 text-2xl font-bold text-stone-900">登录 StepUp</h1>
          <p className="mt-2 text-sm text-stone-500">登录后才能访问你的任务、复盘与知识库；不同账号的数据完全隔离。</p>
          {authError && <p className="mt-3 text-xs text-rose-600">{authError}</p>}
          <button className="btn-primary mt-5" onClick={() => setAuthOpen(true)}>登录 / 注册</button>
          {authError && <button className="btn-ghost ml-2 mt-5" onClick={() => void retryMigration()}>重试数据迁移</button>}
        </div>
        {authOpen && <AuthDialog onClose={() => setAuthOpen(false)} />}
      </div>
    );
  }

  return (
    <div className="min-h-full flex flex-col bg-[#F7F3EB]">
      <header className="sticky top-0 z-30 bg-[#D95427] text-white shadow-sm">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
          <Link to="/" className="flex items-center gap-2.5 shrink-0">
            <LogoMark variant="mark" className="w-7 h-7 text-white" />
            <span className="font-semibold tracking-tight text-white">
              StepUp
            </span>
          </Link>
          <nav className="hidden md:flex items-center gap-0.5">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.to === "/"}
                className={({ isActive }) =>
                  `px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                    isActive
                      ? "bg-white text-brand-600"
                      : "text-white/85 hover:bg-white/15 hover:text-white"
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-2 shrink-0">
            {dueCount > 0 && (
              <Link to="/review" className="rounded-full bg-white/20 px-2 py-1 text-xs text-white">
                待复习 {dueCount}
              </Link>
            )}
            {user ? (
              <button
                className="rounded-full bg-white/15 px-3 py-1.5 text-xs text-white"
                title={user.email ?? user.name}
                onClick={() => {
                  if (user.development) return;
                  void logoutUser().catch((error) => console.error("导航退出失败", error));
                }}
              >
                {user.development ? "本地开发用户" : `${user.email ?? user.name ?? "用户"} · 退出`}
              </button>
            ) : (
              <button className="rounded-full bg-white px-3 py-1.5 text-xs text-brand-600" onClick={() => setAuthOpen(true)}>
                登录 / 注册
              </button>
            )}
            <Link
              to="/membership"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium bg-accent-400 text-stone-900 hover:bg-accent-500 transition"
            >
              {pro ? "Pro 已开通" : "升级 Pro"}
            </Link>
          </div>
        </div>
        <nav className="md:hidden border-t border-white/15 overflow-x-auto">
          <div className="px-2 flex gap-1 py-1.5">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.to === "/"}
                className={({ isActive }) =>
                  `px-3 py-1 rounded-md text-xs font-medium whitespace-nowrap ${
                    isActive
                      ? "bg-white text-brand-600"
                      : "text-white/80"
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </div>
        </nav>
      </header>
      <main className="flex-1">
        <Outlet key={user?.id ?? "anonymous"} />
      </main>
      <footer className="border-t border-[#EDE6D8] bg-[#FBF9F4]">
        <div className="max-w-6xl mx-auto px-4 py-6 text-sm text-stone-500 flex flex-col md:flex-row md:items-center md:justify-between gap-2">
          <div>© 2026 StepUp · 每一步，都向上</div>
          <div className="flex gap-4">
            <Link to="/membership" className="hover:text-brand-600">
              会员
            </Link>
            <a
              href="https://wanderaiai.netlify.app"
              target="_blank"
              rel="noreferrer"
              className="hover:text-brand-600"
            >
              灵感参考
            </a>
          </div>
        </div>
      </footer>
      {authOpen && <AuthDialog onClose={() => setAuthOpen(false)} />}
    </div>
  );
}
