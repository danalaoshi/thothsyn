import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";

interface Folder {
  id: string;
  name: string;
  type: string;
  updated_at: number;
}

export default function Folders() {
  const { token } = useAuth();
  const [items, setItems] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [delId, setDelId] = useState<string | null>(null);

  async function load() {
    if (!token) return;
    setLoading(true);
    setErr(null);
    try {
      const data = await api.get("/folders", token);
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
    if (!confirm("确认删除这个文件夹？其下收藏会回到「未分类」。")) return;
    setDelId(id);
    try {
      await api.del(`/folders/${id}`, token);
      setItems((prev) => prev.filter((f) => f.id !== id));
    } catch (e: any) {
      setErr(e?.message || "删除失败");
    } finally {
      setDelId(null);
    }
  }

  const business = items.filter((f) => f.type === "business");
  const tags = items.filter((f) => f.type !== "business");

  return (
    <div>
      <h2 className="text-xl font-semibold tracking-tight text-slate-100">文件夹</h2>
      <p className="mt-1 text-sm text-slate-400">
        业务文件夹 <span className="tnum text-slate-300">{business.length}</span> 个 · 标签{" "}
        <span className="tnum text-slate-300">{tags.length}</span> 个
        {loading && <span className="ml-1 text-slate-500">· 加载中…</span>}
      </p>

      {err && <p className="mt-4 text-sm text-rose-400">{err}</p>}
      {!loading && items.length === 0 && !err && (
        <div className="mt-10 rounded-xl border border-dashed border-white/12 bg-white/[0.015] px-6 py-12 text-center">
          <p className="text-sm text-slate-400">暂无文件夹</p>
          <p className="mt-1.5 text-xs text-slate-500">
            文件夹在扩展端创建，同步后这里会列出。
          </p>
        </div>
      )}

      {items.length > 0 && (
        <ul className="mt-5 divide-y divide-white/[0.07] border-t border-white/[0.07]">
          {items.map((f) => (
            <li key={f.id} className="flex items-start gap-4 py-4">
              <span
                aria-hidden="true"
                className={`mt-2 h-2 w-2 shrink-0 rounded-sm ${
                  f.type === "business"
                    ? "bg-sky-400/80"
                    : "border border-slate-500/70 bg-transparent"
                }`}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-base font-medium text-slate-100">{f.name}</div>
                <div className="mt-0.5 text-xs text-slate-500">
                  {f.type === "business" ? "业务文件夹（单归属）" : "标签文件夹（多标签）"}
                </div>
              </div>
              <button
                onClick={() => onDelete(f.id)}
                disabled={delId === f.id}
                className="mt-0.5 shrink-0 rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-400 transition hover:border-rose-400/45 hover:text-rose-300 disabled:opacity-45"
              >
                {delId === f.id ? "删除中…" : "删除"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
