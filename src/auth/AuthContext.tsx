import {
  getUser,
  handleAuthCallback,
  login,
  logout,
  onAuthChange,
  signup,
} from "@netlify/identity";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  configureProEntitlement,
  configureStorageUser,
  isTesterModeEnabled,
  isProUnlocked,
  loadReviews,
  loadTaskAiReviews,
  loadWorkspace,
  replaceWorkspaceFromServer,
} from "../lib/storage";
import { syncDevProEntitlement } from "../services/planApi";
import type { Workspace } from "../types/plan";

function testerHeaders(): HeadersInit {
  return isTesterModeEnabled() ? { "X-StepUp-Tester-Mode": "true" } : {};
}

export type AuthUser = { id: string; email?: string; name?: string; development?: boolean };

type AuthContextValue = {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  loginUser: (email: string, password: string) => Promise<void>;
  signupUser: (email: string, password: string, name: string) => Promise<boolean>;
  logoutUser: () => Promise<void>;
  retryMigration: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function normalizeUser(user: Awaited<ReturnType<typeof getUser>>): AuthUser | null {
  if (!user?.id) return null;
  return { id: user.id, email: user.email ?? undefined, name: user.name ?? undefined };
}

function getAuthErrorMessage(error: unknown, action: "login" | "signup"): string {
  const fallback = action === "login" ? "登录失败" : "注册失败";
  if (!(error instanceof Error)) return fallback;
  const status = Number((error as { status?: unknown }).status);
  const message = error.message || fallback;
  if (status === 404 || message.toLowerCase().includes("not found")) {
    return "Netlify Identity 尚未启用，或当前部署没有关联到启用 Identity 的站点。请到 Netlify 项目的 Configuration > Identity 开启。";
  }
  if (status === 401) return "邮箱或密码不正确；如果刚注册，请先确认邮箱或开启 Autoconfirm。";
  if (status === 422) return "该邮箱可能已注册，或当前站点不允许开放注册。请检查 Identity 的 Registration 设置。";
  if (message.toLowerCase().includes("email not confirmed")) {
    return "邮箱还未确认。请先点击 Netlify 发来的确认邮件，或在 Identity 设置中开启 Autoconfirm。";
  }
  return message;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(
    import.meta.env.DEV
      ? { id: "dev-user-local-only", email: "dev@localhost", name: "本地开发用户", development: true }
      : null,
  );
  const [loading, setLoading] = useState(!import.meta.env.DEV);
  const [error, setError] = useState<string | null>(null);

  const retryMigration = async () => {
    try {
      const status = await fetch("/api/workspace", { headers: testerHeaders() });
      if (!status.ok) throw new Error(`迁移状态读取失败 (${status.status})`);
      const data = (await status.json()) as {
        migrated?: boolean;
        entitlement?: { pro?: boolean };
        workspace?: Workspace;
      };
      configureProEntitlement(Boolean(data.entitlement?.pro));
      if (data.migrated) {
        if (data.workspace) replaceWorkspaceFromServer(data.workspace);
        return;
      }
      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...testerHeaders() },
        body: JSON.stringify({
          workspace: loadWorkspace(),
          reviews: loadReviews(),
          taskAiReviews: loadTaskAiReviews(),
        }),
      });
      if (!response.ok) {
        const detail = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(detail.error ?? `迁移失败 (${response.status})`);
      }
      const refreshed = await fetch("/api/workspace", { headers: testerHeaders() });
      if (refreshed.ok) {
        const snapshot = (await refreshed.json()) as {
          entitlement?: { pro?: boolean };
          workspace?: Workspace;
        };
        configureProEntitlement(Boolean(snapshot.entitlement?.pro));
        if (snapshot.workspace) replaceWorkspaceFromServer(snapshot.workspace);
      }
      localStorage.setItem("stepup.serverMigration", "done");
    } catch (migrationError) {
      console.error("本地数据迁移失败，保留本地副本并允许重试", migrationError);
      setError(migrationError instanceof Error ? migrationError.message : "本地数据迁移失败，可重试");
    }
  };

  useEffect(() => {
    if (import.meta.env.DEV) {
      configureStorageUser("dev-user-local-only");
      void (async () => {
        try {
          // 把本地已解锁的 Pro 同步到服务端，避免界面显示 Pro 但 AI 仍按免费限流
          if (isProUnlocked()) {
            const result = await syncDevProEntitlement(true);
            configureProEntitlement(Boolean(result.entitlement?.pro));
          }
        } catch (error) {
          console.error("本地 Pro 启动同步失败，继续按服务端权益", error);
        }
        await retryMigration();
      })();
      return;
    }
    let active = true;
    const initialize = async () => {
      try {
        await handleAuthCallback();
        const current = normalizeUser(await getUser());
        configureStorageUser(current?.id ?? null);
        if (active) setUser(current);
        if (current) await retryMigration();
      } catch (authError) {
        console.error("Identity 初始化失败", authError);
        if (active) setError(authError instanceof Error ? authError.message : "登录状态初始化失败");
      } finally {
        if (active) setLoading(false);
      }
    };
    void initialize();
    const unsubscribe = onAuthChange((_event, current) => {
      const next = normalizeUser(current);
      configureStorageUser(next?.id ?? null);
      setUser(next);
      if (next) void retryMigration();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      error,
      loginUser: async (email, password) => {
        try {
          setError(null);
          const current = await login(email, password);
          const next = normalizeUser(current);
          configureStorageUser(next?.id ?? null);
          setUser(next);
          await retryMigration();
        } catch (loginError) {
          console.error("登录失败", loginError);
          setError(getAuthErrorMessage(loginError, "login"));
          throw loginError;
        }
      },
      signupUser: async (email, password, name) => {
        try {
          setError(null);
          const current = await signup(email, password, { full_name: name });
          const next = normalizeUser(current);
          const verified = Boolean((current as { emailVerified?: unknown }).emailVerified);
          if (!verified) {
            configureStorageUser(null);
            setUser(null);
            setError("注册请求已发送。请先到邮箱点击确认链接；或在 Netlify Identity 中开启 Autoconfirm 后重新注册。");
            return false;
          }
          configureStorageUser(next?.id ?? null);
          setUser(next);
          if (current.id) await retryMigration();
          return true;
        } catch (signupError) {
          console.error("注册失败", signupError);
          setError(getAuthErrorMessage(signupError, "signup"));
          throw signupError;
        }
      },
      logoutUser: async () => {
        try {
          await logout();
          configureProEntitlement(false);
          configureStorageUser(null);
          setUser(null);
        } catch (logoutError) {
          console.error("退出登录失败", logoutError);
          setError(logoutError instanceof Error ? logoutError.message : "退出登录失败");
          throw logoutError;
        }
      },
      retryMigration,
    }),
    [user, loading, error],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth 必须在 AuthProvider 内使用");
  return context;
}
