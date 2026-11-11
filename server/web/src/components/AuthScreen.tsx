import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";

type Mode = "login" | "register" | "forgot";

export default function AuthScreen() {
  const { signIn, signUp, resetPassword, resendConfirmation } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mailUrl, setMailUrl] = useState("");

  useEffect(() => {
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.mail_proxy_enabled) setMailUrl(d.mail_url || "");
      })
      .catch(() => {});
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      if (mode === "login") {
        await signIn(email, password);
      } else if (mode === "register") {
        const { needsConfirm } = await signUp(email, password);
        if (needsConfirm) {
          setMsg(
            mailUrl
              ? "注册成功，请到本地邮箱点开确认链接后登录（本地栈不会发到真实邮箱）。"
              : "注册成功，请查收确认邮件后登录（未收到可点击下方重新发送）。",
          );
          setMode("login");
        }
      } else if (mode === "forgot") {
        await resetPassword(email);
        setMsg(
          mailUrl
            ? "重置密码邮件已发出，请到「本地邮箱」查收（本地栈不会发到真实邮箱）。"
            : "重置密码邮件已发送，请查收。",
        );
      }
    } catch (e: any) {
      setErr(e?.message || "操作失败");
    } finally {
      setBusy(false);
    }
  }

  async function onResend() {
    setErr(null);
    setBusy(true);
    try {
      await resendConfirmation(email);
      setMsg(mailUrl ? "确认邮件已重新发送，请到「本地邮箱」查收。" : "确认邮件已重新发送，请查收。");
    } catch (e: any) {
      setErr(e?.message || "发送失败");
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "rounded-lg border border-white/10 bg-black/30 px-3.5 py-2.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-sky-400/60";

  return (
    <div className="flex min-h-[100dvh] items-center justify-center px-5 py-10">
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-white/[0.03] p-10 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold tracking-[0.18em] text-sky-300">
            THOTHSYN
          </span>
          <span className="text-xs text-slate-600">/</span>
          <span className="text-xs tracking-[0.1em] text-slate-500">CLOUD</span>
        </div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-100">
          {mode === "register" ? "创建账户" : mode === "forgot" ? "找回密码" : "登录"}
        </h1>
        <p className="mt-1.5 text-sm text-slate-400">
          {mode === "login" && "登录以管理你的云端收藏"}
          {mode === "register" && "需邮箱确认，确认后才能开启同步"}
          {mode === "forgot" && "输入邮箱以接收重置链接"}
        </p>

        <form onSubmit={onSubmit} className="mt-7 flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-slate-400">邮箱</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputCls}
              placeholder="you@example.com"
            />
          </label>
          {mode !== "forgot" && (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-slate-400">密码</span>
              <input
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputCls}
                placeholder="至少 6 位"
              />
            </label>
          )}

          {err && <p className="text-sm text-rose-400">{err}</p>}
          {msg && (
            <div>
              <p className="text-sm leading-relaxed text-emerald-400">{msg}</p>
              {mailUrl && (
                <a
                  href={mailUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-2 inline-block text-sm text-sky-300 underline decoration-sky-400/40 underline-offset-4 transition hover:text-sky-200"
                >
                  打开本地邮箱（Mailpit）↗
                </a>
              )}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-1 rounded-lg bg-sky-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-sky-400 disabled:opacity-45"
          >
            {busy
              ? "处理中…"
              : mode === "login"
                ? "登录"
                : mode === "register"
                  ? "注册"
                  : "发送重置邮件"}
          </button>
        </form>

        <div className="mt-6 flex flex-col gap-2 border-t border-white/10 pt-5 text-xs text-slate-400">
          {mode === "login" && (
            <>
              <button
                className="w-fit text-left transition hover:text-slate-100"
                onClick={() => setMode("register")}
              >
                没有账户？去注册
              </button>
              <button
                className="w-fit text-left transition hover:text-slate-100"
                onClick={() => setMode("forgot")}
              >
                忘记密码？
              </button>
              <button
                className="w-fit text-left transition hover:text-slate-100 disabled:opacity-45"
                onClick={onResend}
                disabled={busy || !email}
              >
                重新发送确认邮件
              </button>
            </>
          )}
          {mode === "register" && (
            <button
              className="w-fit text-left transition hover:text-slate-100"
              onClick={() => setMode("login")}
            >
              已有账户？去登录
            </button>
          )}
          {mode === "forgot" && (
            <button
              className="w-fit text-left transition hover:text-slate-100"
              onClick={() => setMode("login")}
            >
              返回登录
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
