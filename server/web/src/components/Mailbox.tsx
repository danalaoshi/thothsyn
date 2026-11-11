import { useCallback, useEffect, useState } from "react";

/**
 * 本地收件箱（仅 dev）。
 *
 * `supabase start` 起的 GoTrue 把注册确认、找回密码、邮箱变更邮件全部投递到
 * 容器内的 Mailpit，不会发到真实邮箱。用户以为「没收到邮件」，其实是没地方看。
 * 这里通过 FastAPI 的 /api/mail 代理把邮件列出来，并只暴露 GoTrue 的 verify
 * 链接作为按钮 —— 邮件正文一律按不可信输入处理，不直接渲染 HTML。
 */

interface MailItem {
  id: string;
  subject: string;
  to: string;
  created: string;
  read: boolean;
}

interface MailDetail {
  id: string;
  subject: string;
  to: string;
  created: string;
  text: string;
  links: string[];
}

function fmt(when: string): string {
  if (!when) return "";
  const d = new Date(when);
  return Number.isNaN(d.getTime()) ? when : d.toLocaleString("zh-CN", { hour12: false });
}

function linkLabel(url: string): string {
  try {
    const t = new URL(url).searchParams.get("type");
    return (
      {
        email_change: "确认邮箱变更",
        signup: "确认注册",
        recovery: "重置密码",
        magiclink: "登录链接",
        invite: "接受邀请",
      }[t || ""] || "打开确认链接"
    );
  } catch {
    return "打开确认链接";
  }
}

export default function Mailbox({ mailUrl }: { mailUrl: string }) {
  const [items, setItems] = useState<MailItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MailDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/mail/messages?limit=30");
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const d = await r.json();
      setItems(d.items || []);
      setTotal(d.total ?? (d.items || []).length);
    } catch (e: any) {
      setErr(e?.message || "读取本地邮箱失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(id: string) {
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(id);
    setDetail(null);
    setDetailBusy(true);
    try {
      const r = await fetch(`/api/mail/messages/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      setDetail(await r.json());
    } catch (e: any) {
      setErr(e?.message || "读取邮件失败");
    } finally {
      setDetailBusy(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-100">本地邮箱</h2>
          <p className="mt-1 text-sm text-slate-400">
            共 <span className="tnum text-slate-300">{total}</span> 封
            {loading && <span className="ml-1 text-slate-500">· 加载中…</span>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={load}
            className="rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-300 transition hover:border-white/20 hover:bg-white/5 hover:text-slate-100"
          >
            刷新
          </button>
          <a
            href={mailUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-300 transition hover:border-white/20 hover:bg-white/5 hover:text-slate-100"
          >
            在 Mailpit 中打开 ↗
          </a>
        </div>
      </div>

      <div className="mt-5 rounded-xl border border-sky-400/25 bg-sky-400/[0.06] px-5 py-4">
        <p className="text-sm text-slate-200">
          本地开发栈不会把邮件发到真实邮箱。GoTrue 发出的注册确认、找回密码、邮箱变更邮件，全部被 Mailpit 捕获在这里。
        </p>
        <p className="mt-2 text-sm text-slate-400">
          <b className="font-medium text-sky-200">邮箱变更会发两封、点一封即可</b>：分别发往旧邮箱和新邮箱，本机实测点其中任意一封确认链接就会生效，另一封随即失效（再点报 <span className="mono">otp_expired</span> 属正常，不是失败）。
        </p>
      </div>

      {err && <p className="mt-4 text-sm text-rose-400">{err}</p>}

      {!loading && items.length === 0 && !err && (
        <div className="mt-8 rounded-xl border border-dashed border-white/12 bg-white/[0.015] px-6 py-12 text-center">
          <p className="text-sm text-slate-400">收件箱是空的</p>
          <p className="mt-2 text-xs text-slate-500">
            在「账户」里修改邮箱，或注册 / 找回密码后，回到这里刷新。
          </p>
        </div>
      )}

      <ul className="mt-5 divide-y divide-white/[0.07] border-t border-white/[0.07]">
        {items.map((m) => (
          <li key={m.id}>
            <button
              onClick={() => toggle(m.id)}
              className="flex w-full items-start gap-4 py-4 text-left transition hover:bg-white/[0.02]"
              aria-expanded={openId === m.id}
            >
              <span
                aria-hidden="true"
                className={`mt-2 h-2 w-2 shrink-0 rounded-full ${
                  m.read ? "bg-slate-600" : "bg-sky-400"
                }`}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-slate-100">{m.subject}</div>
                <div className="mono mt-1 truncate text-xs text-slate-500">收件人：{m.to || "—"}</div>
              </div>
              <span className="tnum hidden shrink-0 text-xs text-slate-500 sm:block">
                {fmt(m.created)}
              </span>
              <span className="shrink-0 text-xs text-slate-500">
                {openId === m.id ? "收起" : "展开"}
              </span>
            </button>

            {openId === m.id && (
              <div className="mb-5 ml-6 rounded-xl border border-white/10 bg-black/20 p-5">
                {detailBusy && <p className="text-sm text-slate-500">读取中…</p>}
                {detail && (
                  <>
                    {detail.links.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {detail.links.map((u) => (
                          <a
                            key={u}
                            href={u}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-400"
                          >
                            {linkLabel(u)} ↗
                          </a>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-amber-300">
                        这封邮件里没有可直接打开的确认链接，请到 Mailpit 查看原文。
                      </p>
                    )}
                    {detail.text && (
                      <pre className="mono mt-4 max-h-52 overflow-auto whitespace-pre-wrap break-all text-xs leading-relaxed text-slate-400">
                        {detail.text}
                      </pre>
                    )}
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
