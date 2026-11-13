import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";

interface Msg {
  id: number;
  sender_id: string;
  recipient_id: string | null;
  title: string;
  body: string;
  created_at: number;
}

export default function Messages({ isSuper }: { isSuper: boolean }) {
  const { token } = useAuth();
  const [inbox, setInbox] = useState<Msg[]>([]);
  const [sent, setSent] = useState<Msg[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [recipient, setRecipient] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function load() {
    if (!token) return;
    try {
      setErr(null);
      const inboxRes = await api.get("/messages?since=0&limit=100", token);
      setInbox([...(inboxRes.items || [])].reverse());
      if (isSuper) {
        const sentRes = await api.get("/admin/messages?limit=100", token);
        setSent(sentRes.items || []);
      }
    } catch (e: any) {
      setErr(e?.message || "加载消息失败");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, isSuper]);

  async function send() {
    if (!token || !title.trim()) return;
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      await api.post("/admin/messages", token, {
        title: title.trim(),
        body,
        recipient_id: recipient.trim() || null,
      });
      setTitle("");
      setBody("");
      setRecipient("");
      setNote("已发送。扩展端下次轮询（约 1 小时内）会收到，并弹出桌面通知。");
      await load();
    } catch (e: any) {
      setErr(e?.message || "发送失败");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: number) {
    if (!token || !confirm(`撤回消息 #${id}？已收到该消息的客户端不会自动删除。`)) return;
    try {
      await api.del(`/admin/messages/${id}`, token);
      await load();
    } catch (e: any) {
      setErr(e?.message || "撤回失败");
    }
  }

  return (
    <div className="w-full">
      <h2 className="text-xl font-semibold tracking-tight text-slate-100">消息</h2>
      <p className="mt-1.5 text-sm text-slate-400">
        后台下发的站内消息。扩展端每小时轮询一次，收到新消息会弹桌面通知；正文按纯文本展示，不解析 HTML。
      </p>
      {err && <p className="mt-4 text-sm text-rose-400">{err}</p>}
      {note && <p className="mt-4 text-sm text-emerald-400">{note}</p>}

      <section className="mt-7">
        <h3 className="flex items-baseline gap-2 text-sm font-medium text-slate-200">
          我收到的消息
          <span className="tnum text-xs text-slate-500">{inbox.length}</span>
          <button
            onClick={() => void load()}
            className="ml-2 rounded-md border border-white/10 px-3 py-1 text-xs text-slate-400 transition hover:border-white/20 hover:text-slate-100"
          >
            刷新
          </button>
        </h3>
        {inbox.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">暂无消息。</p>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            {inbox.map((m) => (
              <div key={m.id} className="rounded-xl border border-white/10 bg-white/[0.02] px-5 py-4">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-base font-medium text-slate-100">{m.title}</span>
                  <span className="text-xs text-slate-500">
                    {fmtTime(m.created_at)}
                    {m.recipient_id ? " · 定向" : " · 全体"}
                  </span>
                </div>
                {m.body && (
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">
                    {m.body}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {isSuper && (
        <>
          <section className="mt-9">
            <h3 className="text-base font-medium text-slate-100">发送消息（超管）</h3>
            <p className="mt-1.5 text-sm text-slate-400">
              收件人 ID 留空 = 全体注册用户；填写 user_id = 只发给该用户。
            </p>
            <div className="mt-4 flex max-w-2xl flex-col gap-3">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                placeholder="标题（必填，最多 200 字）"
                className="rounded-lg border border-white/10 bg-black/30 px-3.5 py-2.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-sky-400/60"
              />
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={2000}
                rows={4}
                placeholder="正文（纯文本，最多 2000 字）"
                className="resize-y rounded-lg border border-white/10 bg-black/30 px-3.5 py-2.5 text-sm leading-relaxed text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-sky-400/60"
              />
              <input
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                maxLength={36}
                placeholder="收件人 user_id（可选，留空为全体）"
                className="rounded-lg border border-white/10 bg-black/30 px-3.5 py-2.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-sky-400/60"
              />
              <div>
                <button
                  onClick={() => void send()}
                  disabled={busy || !title.trim()}
                  className="rounded-lg bg-sky-500 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-sky-400 disabled:opacity-45"
                >
                  发送
                </button>
              </div>
            </div>
          </section>

          <section className="mt-9">
            <h3 className="flex items-baseline gap-2 text-sm font-medium text-slate-200">
              已发送
              <span className="tnum text-xs text-slate-500">{sent.length}</span>
            </h3>
            {sent.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">还没有发过消息。</p>
            ) : (
              <div className="mt-2.5 overflow-x-auto rounded-xl border border-white/10">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-white/[0.03]">
                    <tr>
                      <Th>#</Th>
                      <Th>标题</Th>
                      <Th>收件人</Th>
                      <Th>时间</Th>
                      <Th> </Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06]">
                    {sent.map((m) => (
                      <tr key={m.id} className="transition hover:bg-white/[0.02]">
                        <Td className="tnum text-xs text-slate-500">{m.id}</Td>
                        <Td>{m.title}</Td>
                        <Td className="mono text-xs text-slate-500">
                          {m.recipient_id || "全体"}
                        </Td>
                        <Td className="text-xs text-slate-500">{fmtTime(m.created_at)}</Td>
                        <Td>
                          <button
                            onClick={() => void revoke(m.id)}
                            className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-400 transition hover:border-rose-400/45 hover:text-rose-300"
                          >
                            撤回
                          </button>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
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

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="whitespace-nowrap px-5 py-3 text-xs font-medium tracking-wide text-slate-400">
      {children}
    </th>
  );
}
function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-5 py-3.5 text-slate-200 ${className}`}>{children}</td>;
}
