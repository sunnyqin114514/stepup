import { useState } from "react";
import { useAuth } from "../auth/AuthContext";

export default function AuthDialog({ onClose }: { onClose: () => void }) {
  const { loginUser, signupUser, error } = useAuth();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async () => {
    setLocalError(null);
    const trimmedEmail = email.trim();
    const trimmedName = name.trim();
    if (!trimmedEmail) {
      setLocalError("请输入邮箱。");
      return;
    }
    if (password.length < 8) {
      setLocalError("密码至少需要 8 位。");
      return;
    }
    if (mode === "signup" && !trimmedName) {
      setLocalError("注册时请填写昵称。");
      return;
    }
    setBusy(true);
    try {
      if (mode === "login") await loginUser(trimmedEmail, password);
      else {
        const signedIn = await signupUser(trimmedEmail, password, trimmedName);
        if (!signedIn) return;
      }
      onClose();
    } catch (submitError) {
      console.error("认证表单提交失败，错误已展示", submitError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4" onClick={onClose}>
      <form className="card w-full max-w-sm p-5" onClick={(event) => event.stopPropagation()} onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}>
        <h2 className="text-lg font-semibold text-stone-900">{mode === "login" ? "登录 StepUp" : "创建账号"}</h2>
        <p className="mt-1 text-xs text-stone-500">登录后数据会按账号隔离并同步到 Netlify。</p>
        {mode === "signup" && (
          <input className="input-field mt-4" placeholder="昵称" value={name} onChange={(event) => setName(event.target.value)} />
        )}
        <input className="input-field mt-3" type="email" placeholder="邮箱" value={email} onChange={(event) => setEmail(event.target.value)} />
        <input className="input-field mt-3" type="password" placeholder="密码（至少 8 位）" value={password} onChange={(event) => setPassword(event.target.value)} />
        {(localError || error) && <p className="mt-2 text-xs text-rose-600">{localError || error}</p>}
        <button className="btn-primary mt-4 w-full" type="submit" disabled={busy}>
          {busy ? "处理中…" : mode === "login" ? "登录" : "注册"}
        </button>
        <button className="mt-3 w-full text-sm text-brand-600" type="button" onClick={() => {
          setLocalError(null);
          setMode(mode === "login" ? "signup" : "login");
        }}>
          {mode === "login" ? "没有账号？注册" : "已有账号？登录"}
        </button>
      </form>
    </div>
  );
}
