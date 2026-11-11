import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";

interface UserRow {
  id: string;
  email: string | null;
  email_confirmed_at: string | null;
  level: string | null;
  is_paid: boolean | null;
  is_superuser: boolean | null;
}

interface CapRow {
  id: string;
  user_id: string;
  title: string;
  url: string;
  kind: string;
  updated_at: number;
}

export default function AdminPanel() {
  const { token } = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [caps, setCaps] = useState<CapRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [delId, setDelId] = useState<string | null>(null);

  async function load() {
    if (!token) return;
    setLoading(true);
    setErr(null);
    try {
      const [u, c] = await Promise.all([
        api.get("/admin/users", token),
        api.get("/admin/captures?limit=200", token),
      ]);
      setUsers(u.items || []);
      setCaps(c.items || []);
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

  async function onDeleteCap(id: string) {
    if (!token) return;
    if (!confirm("超管操作：确认删除该用户的这条收藏？")) return;
    setDelId(id);
    try {
      await api.del(`/admin/captures/${id}`, token);
      setCaps((prev) => prev.filter((c) => c.id !== id));
    } catch (e: any) {
      setErr(e?.message || "删除失败");
    } finally {
      setDelId(null);
    }
  }

  return (
    <div>
      <h2 className="text-xl font-semibold tracking-tight text-slate-100">管理（超管）</h2>
      <p className="mt-1 text-sm text-slate-400">
        跨用户视角。这里的删除会直接生效，不做二次恢复。
        {loading && <span className="ml-1 text-slate-500">· 加载中…</span>}
      </p>
      {err && <p className="mt-4 text-sm text-rose-400">{err}</p>}

      <section className="mt-7">
        <h3 className="flex items-baseline gap-2 text-sm font-medium text-slate-200">
          用户
          <span className="tnum text-xs text-slate-500">{users.length}</span>
        </h3>
        <div className="mt-2.5 overflow-x-auto rounded-xl border border-white/10">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-white/[0.03]">
              <tr>
                <Th>邮箱</Th>
                <Th>已确认</Th>
                <Th>等级</Th>
                <Th>付费</Th>
                <Th>超管</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06]">
              {users.map((u) => (
                <tr key={u.id} className="transition hover:bg-white/[0.02]">
                  <Td>{u.email || u.id}</Td>
                  <Td>{u.email_confirmed_at ? "是" : "否"}</Td>
                  <Td>{u.level ?? "—"}</Td>
                  <Td>{u.is_paid ? "是" : "否"}</Td>
                  <Td>{u.is_superuser ? "是" : "否"}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-9">
        <h3 className="flex items-baseline gap-2 text-sm font-medium text-slate-200">
          全部收藏
          <span className="tnum text-xs text-slate-500">{caps.length}</span>
        </h3>
        <div className="mt-2.5 overflow-x-auto rounded-xl border border-white/10">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-white/[0.03]">
              <tr>
                <Th>标题</Th>
                <Th>用户</Th>
                <Th>类型</Th>
                <Th> </Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06]">
              {caps.map((c) => (
                <tr key={c.id} className="transition hover:bg-white/[0.02]">
                  <Td className="max-w-[36rem] truncate">{c.title || "(无标题)"}</Td>
                  <Td className="mono max-w-[14rem] truncate text-xs text-slate-500">
                    {c.user_id}
                  </Td>
                  <Td>{c.kind}</Td>
                  <Td>
                    <button
                      onClick={() => onDeleteCap(c.id)}
                      disabled={delId === c.id}
                      className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-slate-400 transition hover:border-rose-400/45 hover:text-rose-300 disabled:opacity-45"
                    >
                      {delId === c.id ? "删除中…" : "删除"}
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
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
