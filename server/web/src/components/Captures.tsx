import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";

interface Capture {
  id: string;
  title: string;
  url: string;
  kind: string;
  folder_id: string | null;
  tags: string[];
  updated_at: number;
  text?: string;
}

/** epoch ms → 2026-11-10 22:31，等宽字下对齐好看 */
function fmtDate(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function Captures() {
  const { token } = useAuth();
  const [items, setItems] = useState<Capture[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [delId, setDelId] = useState<string | null>(null);

  async function load() {
    if (!token) return;
    setLoading(true);
    setErr(null);
    try {
      const params = q ? `?q=${encodeURIComponent(q)}` : "";
      const data = await api.get(`/captures${params}`, token);
      setItems(data.items || []);
    } catch (e: any) {
      setErr(e?.message || "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function onDelete(id: string) {
    if (!token) return;
    if (!confirm("确认删除这条收藏？")) return;
    setDelId(id);
    try {
      await api.del(`/captures/${id}`, token);
      setItems((prev) => prev.filter((c) => c.id !== id));
    } catch (e: any) {
      setErr(e?.message || "删除失败");
    } finally {
      setDelId(null);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-100">收藏</h2>
          <p className="mt-1 text-sm text-slate-400">
            共 <span className="tnum text-slate-300">{items.length}</span> 条
            {loading && <span className="ml-1 text-slate-500">· 加载中…</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load()}
            placeholder="搜索标题 / 正文"
            className="w-72 rounded-lg border border-white/10 bg-black/30 px-3.5 py-2.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-sky-400/60"
          />
          <button
            onClick={load}
            className="rounded-lg border border-white/10 px-4 py-2.5 text-sm text-slate-300 transition hover:border-white/20 hover:bg-white/5 hover:text-slate-100"
          >
            搜索
          </button>
        </div>
      </div>

      {err && <p className="mt-4 text-sm text-rose-400">{err}</p>}
      {!loading && items.length === 0 && !err && (
        <div className="mt-10 rounded-xl border border-dashed border-white/12 bg-white/[0.015] px-6 py-12 text-center">
          <p className="text-sm text-slate-400">还没有云端收藏</p>
          <p className="mt-1.5 text-xs text-slate-500">
            在扩展的设置页登录并点「立即同步」，收藏就会出现在这里。
          </p>
        </div>
      )}

      <ul className="mt-5 divide-y divide-white/[0.07] border-t border-white/[0.07]">
        {items.map((c) => (
          <li key={c.id} className="group flex items-start gap-5 py-4">
            <div className="min-w-0 flex-1">
              <div className="truncate text-base font-medium text-slate-100">
                {c.title || "(无标题)"}
              </div>
              {/* 只有真链接才用等宽体，中文说明用正文字体，避免等宽回退字把字距拉散 */}
              <div
                className={`mt-0.5 truncate text-xs text-slate-500 ${c.url ? "mono" : ""}`}
              >
                {c.url || (c.kind === "partial" ? "片段收藏 · 无原链接" : "整页收藏 · 无原链接")}
              </div>
              {Array.isArray(c.tags) && c.tags.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {c.tags.map((t) => (
                    <span
                      key={t}
                      className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-xs text-slate-400"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <span className="tnum mt-0.5 hidden shrink-0 text-xs text-slate-500 sm:block">
              {fmtDate(c.updated_at)}
            </span>
            <button
              onClick={() => onDelete(c.id)}
              disabled={delId === c.id}
              className="mt-0.5 shrink-0 rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-400 transition hover:border-rose-400/45 hover:text-rose-300 disabled:opacity-45"
            >
              {delId === c.id ? "删除中…" : "删除"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
