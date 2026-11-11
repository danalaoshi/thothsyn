import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";
import Captures from "./Captures";
import Folders from "./Folders";
import AdminPanel from "./AdminPanel";
import Mailbox from "./Mailbox";

type Tab = "account" | "captures" | "folders" | "admin" | "mailbox";

export default function Dashboard() {
  const { user, token, signOut, updatePassword, updateEmail } = useAuth();
  const [tab, setTab] = useState<Tab>("account");
  const [me, setMe] = useState<any>(null);
  const [meErr, setMeErr] = useState<string | null>(null);
  const [mail, setMail] = useState<{ url: string; enabled: boolean }>({
    url: "",
    enabled: false,
  });

  async function loadMe() {
    if (!token) return;
    try {
      setMeErr(null);
      const data = await api.get("/me", token);
      setMe(data);
    } catch (e: any) {
      setMeErr(e?.message || "获取账户信息失败");
    }
  }

  useEffect(() => {
    loadMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    // /api/config 是公开端点，返回本地邮箱入口（生产环境会自动关闭代理）
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setMail({ url: d.mail_url || "", enabled: !!d.mail_proxy_enabled });
      })
      .catch(() => {});
  }, []);

  const isSuper = !!me?.is_superuser;

  return (
    <div className="flex min-h-[100dvh]">
      {/* 侧栏：flex 纵向布局，页脚用 mt-auto 压底 */}
      <aside className="sticky top-0 flex h-[100dvh] w-64 shrink-0 flex-col border-r border-white/10 bg-white/[0.025] px-4 py-6">
        <div className="px-3">
          <div className="flex items-baseline gap-2">
            <span className="text-base font-semibold tracking-[0.14em] text-slate-100">
              THOTHSYN
            </span>
            <span className="mono rounded border border-white/10 px-1.5 py-0.5 text-xs text-slate-500">
              manage
            </span>
          </div>
          <p className="mt-1.5 text-xs text-slate-500">云端收藏管理</p>
        </div>

        <nav className="mt-7 flex flex-col gap-1 text-sm">
          <NavBtn active={tab === "account"} onClick={() => setTab("account")}>
            账户
          </NavBtn>
          <NavBtn active={tab === "captures"} onClick={() => setTab("captures")}>
            收藏
          </NavBtn>
          <NavBtn active={tab === "folders"} onClick={() => setTab("folders")}>
            文件夹
          </NavBtn>
          {mail.enabled && (
            <NavBtn active={tab === "mailbox"} onClick={() => setTab("mailbox")}>
              本地邮箱
            </NavBtn>
          )}
          {isSuper && (
            <NavBtn active={tab === "admin"} onClick={() => setTab("admin")}>
              管理（超管）
            </NavBtn>
          )}
        </nav>

        <div className="mt-auto border-t border-white/10 pt-4">
          <div
            className="mono truncate px-2 text-xs text-slate-500"
            title={user?.email || ""}
          >
            {user?.email || user?.id}
          </div>
          <button
            onClick={signOut}
            className="mt-3 w-full rounded-lg border border-white/10 px-2 py-2 text-xs text-slate-300 transition hover:border-white/20 hover:bg-white/5 hover:text-slate-100"
          >
            退出登录
          </button>
        </div>
      </aside>

      {/* 内容区随窗口铺满：不再用 max-w-5xl 把内容锁在 1024px 中间 */}
      <main className="min-w-0 flex-1 overflow-auto">
        <div className="w-full px-8 py-9 lg:px-12 xl:px-16">
          {tab === "account" && (
            <AccountView
              me={me}
              meErr={meErr}
              onChanged={loadMe}
              updatePassword={updatePassword}
              updateEmail={updateEmail}
              onOpenMailbox={mail.enabled ? () => setTab("mailbox") : null}
              mailUrl={mail.url}
            />
          )}
          {tab === "captures" && <Captures />}
          {tab === "folders" && <Folders />}
          {tab === "admin" && isSuper && <AdminPanel />}
          {tab === "mailbox" && mail.enabled && <Mailbox mailUrl={mail.url} />}
        </div>
      </main>
    </div>
  );
}

function NavBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition ${
        active
          ? "bg-sky-500/12 font-medium text-sky-200"
          : "text-slate-300 hover:bg-white/5 hover:text-slate-100"
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-4 w-0.5 shrink-0 rounded-full transition ${
          active ? "bg-sky-400" : "bg-transparent"
        }`}
      />
      {children}
    </button>
  );
}

function AccountView({
  me,
  meErr,
  onChanged,
  updatePassword,
  updateEmail,
  onOpenMailbox,
  mailUrl,
}: {
  me: any;
  meErr: string | null;
  onChanged: () => void;
  updatePassword: (p: string) => Promise<void>;
  updateEmail: (e: string) => Promise<void>;
  onOpenMailbox: (() => void) | null;
  mailUrl: string;
}) {
  const [pw, setPw] = useState("");
  const [em, setEm] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function changePassword() {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      await updatePassword(pw);
      setMsg("密码已更新");
      setPw("");
    } catch (e: any) {
      setErr(e?.message || "更新失败");
    } finally {
      setBusy(false);
    }
  }

  async function changeEmail() {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      await updateEmail(em);
      // 本地栈的邮件不会进真实邮箱；实测两封里点任意一封即生效
      setMsg(
        onOpenMailbox
          ? "确认邮件已发出：旧邮箱、新邮箱各一封，点其中任意一封的确认链接即生效。请到「本地邮箱」查看。"
          : "确认邮件已发出：旧邮箱、新邮箱各一封，点其中任意一封的确认链接即生效。",
      );
      setEm("");
      onChanged();
    } catch (e: any) {
      setErr(e?.message || "更新失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full">
      <h2 className="text-xl font-semibold tracking-tight text-slate-100">账户</h2>
      <p className="mt-1.5 text-sm text-slate-400">
        这里改的密码与邮箱，同样作用于扩展端的云同步登录。
      </p>

      {meErr && <p className="mt-3 text-sm text-rose-400">{meErr}</p>}

      {/* 本地邮件说明：避免「没收到变更邮件」这种误判 */}
      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-xl border border-sky-400/25 bg-sky-400/[0.06] px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-sky-200">本地环境不会发真实邮件</p>
          <p className="mt-1 text-sm text-slate-400">
            注册确认、找回密码、邮箱变更邮件都被本地 Mailpit 捕获，请到「本地邮箱」查看；邮箱变更会发两封（旧 / 新邮箱），点其中一封的确认链接即可生效。
          </p>
        </div>
        {onOpenMailbox && (
          <button
            onClick={onOpenMailbox}
            className="shrink-0 rounded-lg border border-sky-400/40 bg-sky-400/10 px-4 py-2 text-sm font-medium text-sky-200 transition hover:bg-sky-400/20"
          >
            打开本地邮箱
          </button>
        )}
        {!onOpenMailbox && mailUrl && (
          <a
            href={mailUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="shrink-0 rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-300 transition hover:bg-white/5"
          >
            打开 Mailpit ↗
          </a>
        )}
      </div>

      {me && (
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <Field
            label="邮箱"
            value={me.email || "—"}
            className="sm:col-span-2 lg:col-span-3 xl:col-span-2"
          />
          <Field label="等级" value={me.level} />
          <Field label="邮箱已确认" value={me.email_confirmed ? "是" : "否"} />
          <Field label="已付费" value={me.is_paid ? "是" : "否"} />
          <Field label="超管" value={me.is_superuser ? "是" : "否"} />
        </div>
      )}

      <div className="mt-8 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <section className="rounded-xl border border-white/10 bg-white/[0.02] p-6">
          <h3 className="text-base font-medium text-slate-100">修改密码</h3>
          <p className="mt-1.5 text-sm text-slate-400">
            至少 6 位，修改后其它设备需重新登录。
          </p>
          <div className="mt-4 flex max-w-2xl flex-col gap-2 sm:flex-row">
            <input
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="新密码"
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3.5 py-2.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-sky-400/60"
            />
            <button
              onClick={changePassword}
              disabled={busy || pw.length < 6}
              className="shrink-0 rounded-lg bg-sky-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-sky-400 disabled:opacity-45"
            >
              更新密码
            </button>
          </div>
        </section>

        <section className="rounded-xl border border-white/10 bg-white/[0.02] p-6">
          <h3 className="text-base font-medium text-slate-100">修改邮箱</h3>
          <p className="mt-1.5 text-sm text-slate-400">
            会向旧邮箱和新邮箱各发一封确认信，点其中任意一封后新邮箱即生效。
          </p>
          <div className="mt-4 flex max-w-2xl flex-col gap-2 sm:flex-row">
            <input
              type="email"
              value={em}
              onChange={(e) => setEm(e.target.value)}
              placeholder="新邮箱"
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3.5 py-2.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-sky-400/60"
            />
            <button
              onClick={changeEmail}
              disabled={busy || !em}
              className="shrink-0 rounded-lg bg-sky-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-sky-400 disabled:opacity-45"
            >
              发送确认
            </button>
          </div>
        </section>
      </div>

      {err && <p className="mt-4 text-sm text-rose-400">{err}</p>}
      {msg && <p className="mt-4 text-sm leading-relaxed text-emerald-400">{msg}</p>}
    </div>
  );
}

function Field({
  label,
  value,
  className = "",
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div
      className={`min-w-0 rounded-lg border border-white/10 bg-black/20 px-4 py-3 ${className}`}
    >
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 truncate text-sm text-slate-100" title={value}>
        {value}
      </div>
    </div>
  );
}
