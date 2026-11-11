import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/**
 * 扩展点「管理线上内容」时会把令牌放进 URL hash 带过来，这里直接接管：
 * 用户已经登录过扩展，就不该在网页上再输一次密码。
 *
 * 为什么用 hash 而不是 query：fragment 不会发给服务端，也不会进 Referer；
 * 接管后立刻 replaceState 抹掉，避免留在地址栏和历史记录里。
 */
async function adoptHashSession(c: SupabaseClient): Promise<void> {
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) return;
  const params = new URLSearchParams(raw);
  const access = params.get("access_token");
  const refresh = params.get("refresh_token");
  if (!access || !refresh) return;
  try {
    await c.auth.setSession({ access_token: access, refresh_token: refresh });
  } catch {
    // 令牌失效就当没带过来，用户仍可在本页手工登录
  }
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}

// 从 FastAPI 的 /api/config 拉取「本就公开」的 Supabase 网关地址与 anon key，
// 避免在前端写死配置。anon/publishable key 可安全暴露。
export async function getSupabase(): Promise<SupabaseClient> {
  if (client) return client;
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error("无法获取 Supabase 配置");
  const cfg = await res.json();
  client = createClient(cfg.supabase_url, cfg.supabase_anon_key, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  await adoptHashSession(client);
  return client;
}
