import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";

interface FeedbackItem {
  id: number;
  user_id: string | null;
  account_email: string | null;
  contact_type: "im" | "email";
  contact: string;
  content: string;
  client_version: string;
  created_at: number;
  is_read: boolean;
  read_at: number | null;
}

/** 用户留言管理（仅超管）：正文与联系方式一律交给 React 自动转义，不解析 HTML。 */
export default function Feedback() {
  const { token } = useAuth();
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function load() {
    if (!token) return;
    try {
      setErr(null);
      const data = await api.get(
        `/admin/feedback?limit=200${onlyUnread ? "&only_unread=true" : ""}`,
        token,
      );
      setItems(data.items || []);
      setUnread(data.unread || 0);
    } catch (e: any) {
      setErr(e?.message || "加载留言失败");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, onlyUnread]);

  async function markRead(f: FeedbackItem) {
    if (!token) return;
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/admin/feedback/${f.id}/read`, token);
      await load();
    } catch (e: any) {
      setErr(e?.message || "标记失败");
    } finally {
      setBusy(false);
    }
  }

  async function remove(f: FeedbackItem) {
    if (!token || !confirm(`删除留言 #${f.id}？删除后无法恢复。`)) return;
    setBusy(true);
    setErr(null);
    try {
      await api.del(`/admin/feedback/${f.id}`, token);
      setNote(`已删除留言 #${f.id}`);
      await load();
    } catch (e: any) {
      setErr(e?.message || "删除失败");
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNote("联系方式已复制");
    } catch {
      setErr("复制失败，请手动选中复制");
    }
  }

  return (
    <div className="w-full">
      <h2 className="text-xl font-semibold tracking-tight text-slate-100">留言</h2>
      <p className="mt-1.5 text-sm text-slate-400">
        用户在扩展设置页提交的留言，匿名也能提交。最多 500 字，必须留一个联系方式便于回访；正文按纯文本展示，不解析 HTML。
      </p>
      {err && <p className="mt-4 text-sm text-rose-400">{err}</p>}
      {note && <p className="mt-4 text-sm text-emerald-400">{note}</p>}

      <section className="mt-7">
        <h3 className="flex flex-wrap items-baseline gap-2 text-sm font-medium text-slate-200">
          全部留言
          <span className="tnum text-xs text-slate-500">{items.length}</span>
          <span className="rounded-full border border-sky-400/35 bg-sky-400/10 px-2 py-0.5 text-xs text-sky-200">
            未读 {unread}
          </span>
          <button
            onClick={() => void load()}
            className="ml-2 rounded-md border border-white/10 px-3 py-1 text-xs text-slate-400 transition hover:border-white/20 hover:text-slate-100"
          >
            刷新
          </button>
          <button
            onClick={() => setOnlyUnread((v) => !v)}
            className={`rounded-md border px-3 py-1 text-xs transition ${
              onlyUnread
                ? "border-sky-400/45 bg-sky-400/10 text-sky-200"
                : "border-white/10 text-slate-400 hover:border-white/20 hover:text-slate-100"
            }`}
          >
            {onlyUnread ? "只看未读：开" : "只看未读"}
          </button>
        </h3>

        {items.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">
            {onlyUnread ? "没有未读留言。" : "还没有收到留言。"}
          </p>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            {items.map((f) => (
              <div
                key={f.id}
                className={`rounded-xl border px-5 py-4 ${
                  f.is_read
                    ? "border-white/10 bg-white/[0.02]"
                    : "border-sky-400/25 bg-sky-400/[0.04]"
                }`}
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="tnum text-xs text-slate-500">#{f.id}</span>
                  {!f.is_read && (
                    <span className="rounded-full bg-sky-400/15 px-2 py-0.5 text-xs text-sky-200">
                      未读
                    </span>
                  )}
                  <span className="text-xs text-slate-500">{fmtTime(f.created_at)}</span>
                  <span className="text-xs text-slate-500">
                    来源：{f.account_email || (f.user_id ? `账号 ${f.user_id}` : "匿名")}
                  </span>
                  {f.client_version && (
                    <span className="mono text-xs text-slate-500">v{f.client_version}</span>
                  )}
                </div>

                <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-200">
                  {f.content}
                </p>

                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
                  <span className="rounded-md border border-white/10 px-2 py-0.5 text-xs text-slate-400">
                    {f.contact_type === "email" ? "邮箱" : "IM"}
                  </span>
                  <span className="min-w-0 break-all text-sm text-slate-200">{f.contact}</span>
                  <button
                    onClick={() => void copy(f.contact)}
                    className="rounded-md border border-white/10 px-2.5 py-1 text-xs text-slate-400 transition hover:border-white/20 hover:text-slate-100"
                  >
                    复制
                  </button>
                  <span className="ml-auto flex gap-2">
                    {!f.is_read && (
                      <button
                        disabled={busy}
                        onClick={() => void markRead(f)}
                        className="rounded-md border border-sky-400/40 bg-sky-400/10 px-3 py-1.5 text-xs text-sky-200 transition hover:bg-sky-400/20 disabled:opacity-45"
                      >
                        标记已读
                      </button>
                    )}
                    <button
                      disabled={busy}
                      onClick={() => void remove(f)}
                      className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-400 transition hover:border-rose-400/45 hover:text-rose-300 disabled:opacity-45"
                    >
                      删除
                    </button>
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function fmtTime(ms: number): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}
