import { ext } from './webext';
/**
 * 云同步客户端（扩展端）。
 *
 * 与 v2 服务端的契约（server/app/routers/sync.py）：
 *   POST {server}/api/sync  { mode, cursor, changes[] }
 *   → { server_cursor, changes[], conflicts[] }
 *
 * 三条不能违反的规则：
 * 1. **整页收藏只上传链接**：kind=full 时 html 置空，云端只存 url + 标题。
 *    部分收藏才上传 DOM 片段，这是「尽可能少占空间」的落地方式。
 * 2. **下行不覆盖本地快照**：云端返回的 full 记录没有 html，落库时必须保留
 *    本地已有的快照，否则一次同步就把离线阅读能力抹掉了。
 * 3. **删除靠墓碑传播**：本地真删（UI 不变），墓碑随下次同步上传。
 *
 * 冲突裁决：服务端按 updated_at 做 LWW（大者胜），把败方放进 conflicts；
 * 客户端对普通下行也做同样的比较，防止「本地改过但还没推」的记录被旧的
 * 云端版本覆盖。
 */
import { db } from '../db/database';
import type { Capture, Folder } from '../types';
import {
  clearTombstone,
  nowMs,
  purgeCapture,
  purgeFolder,
} from './repo';
import { README_ID } from './readme';
import { bumpRevision } from './settings';

/** 默认服务器地址：托管 FastAPI（管理页与 API 同源，见根 README） */
export const DEFAULT_SERVER_URL = 'http://137.175.107.92:5200';

export const SERVER_URL_KEY = 'thothServerUrl';
export const AUTH_KEY = 'thothAuth';
export const SYNC_META_KEY = 'thothSyncMeta';
export const SYNC_MODE_KEY = 'thothSyncMode';
export const AUTO_SYNC_KEY = 'thothAutoSync';

export type SyncMode = 'push' | 'pull' | 'both';
export type Level = 'unverified' | 'formal' | 'paid' | 'superuser';

export const LEVEL_LABEL: Record<Level, string> = {
  unverified: '未验证邮箱',
  formal: '正式用户',
  paid: '付费用户',
  superuser: '超级用户',
};

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  /** epoch 秒 */
  expiresAt: number;
  userId: string;
  email: string;
  level: Level;
  isPaid: boolean;
  isSuperuser: boolean;
}

export interface SyncMeta {
  /** 服务端时间游标：只拉 updated_at > cursor 的记录 */
  cursor: number;
  /** 上次同步开始时的本地时间：只推 updatedAt > lastPushAt 的记录 */
  lastPushAt: number;
  lastSyncAt: number;
  lastResult: string;
}

interface WireChange {
  entity: 'capture' | 'folder';
  op: 'upsert' | 'delete';
  record: Record<string, unknown>;
}

export interface SyncReport {
  mode: SyncMode;
  pushed: number;
  pulled: number;
  conflicts: number;
  cursor: number;
  at: number;
}

// ---------------- 存储 ----------------

async function readKey<T>(key: string): Promise<T | undefined> {
  const raw = await ext.storage.local.get(key);
  return raw[key] as T | undefined;
}

async function writeKey(key: string, value: unknown): Promise<void> {
  await ext.storage.local.set({ [key]: value });
}

export async function getServerUrl(): Promise<string> {
  const v = await readKey<string>(SERVER_URL_KEY);
  return (v || DEFAULT_SERVER_URL).replace(/\/+$/, '');
}

export async function setServerUrl(url: string): Promise<void> {
  await writeKey(SERVER_URL_KEY, url.trim().replace(/\/+$/, '') || DEFAULT_SERVER_URL);
}

export async function getSession(): Promise<AuthSession | null> {
  return (await readKey<AuthSession>(AUTH_KEY)) ?? null;
}

export async function getSyncMode(): Promise<SyncMode> {
  const v = await readKey<SyncMode>(SYNC_MODE_KEY);
  return v === 'push' || v === 'pull' || v === 'both' ? v : 'both';
}

export async function setSyncMode(mode: SyncMode): Promise<void> {
  await writeKey(SYNC_MODE_KEY, mode);
}

export async function getAutoSync(): Promise<boolean> {
  return (await readKey<boolean>(AUTO_SYNC_KEY)) === true;
}

export async function setAutoSync(on: boolean): Promise<void> {
  await writeKey(AUTO_SYNC_KEY, on);
}

export async function getMeta(): Promise<SyncMeta> {
  const m = await readKey<SyncMeta>(SYNC_META_KEY);
  return {
    cursor: Number(m?.cursor) || 0,
    lastPushAt: Number(m?.lastPushAt) || 0,
    lastSyncAt: Number(m?.lastSyncAt) || 0,
    lastResult: m?.lastResult ?? '',
  };
}

async function saveMeta(patch: Partial<SyncMeta>): Promise<void> {
  await writeKey(SYNC_META_KEY, { ...(await getMeta()), ...patch });
}

// ---------------- HTTP ----------------

interface SessionOut {
  access_token?: string | null;
  refresh_token?: string | null;
  expires_at?: number | null;
  user_id?: string | null;
  email?: string | null;
  email_confirmed?: boolean;
  needs_confirmation?: boolean;
}

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { detail?: unknown };
    if (typeof data.detail === 'string' && data.detail) return data.detail;
    return `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

async function authRequest(path: string, body: unknown): Promise<SessionOut> {
  const base = await getServerUrl();
  let res: Response;
  try {
    res = await fetch(`${base}/api/auth${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`连不上服务器 ${base}，请确认后端已启动`);
  }
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as SessionOut;
}

/** 会话补齐等级：登录后立刻拉一次 /api/me，才知道能不能同步 */
async function withProfile(session: AuthSession): Promise<AuthSession> {
  try {
    const base = await getServerUrl();
    const res = await fetch(`${base}/api/me`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    if (res.ok) {
      const me = (await res.json()) as {
        level?: Level;
        is_paid?: boolean;
        is_superuser?: boolean;
        email?: string;
      };
      return {
        ...session,
        level: me.level ?? session.level,
        isPaid: me.is_paid ?? false,
        isSuperuser: me.is_superuser ?? false,
        email: me.email ?? session.email,
      };
    }
  } catch {
    // /api/me 不可达不影响登录本身，等级留待下次同步前再补齐
  }
  return session;
}

function toSession(out: SessionOut, fallbackEmail: string): AuthSession {
  return {
    accessToken: out.access_token ?? '',
    refreshToken: out.refresh_token ?? '',
    expiresAt: out.expires_at ?? 0,
    userId: out.user_id ?? '',
    email: out.email ?? fallbackEmail,
    level: 'unverified',
    isPaid: false,
    isSuperuser: false,
  };
}

export async function signIn(email: string, password: string): Promise<AuthSession> {
  const out = await authRequest('/login', { email, password });
  if (!out.access_token) throw new Error('登录失败：服务端未返回令牌');
  const session = await withProfile(toSession(out, email));
  await writeKey(AUTH_KEY, session);
  return session;
}

export async function signUp(
  email: string,
  password: string,
): Promise<{ session: AuthSession | null; needsConfirmation: boolean }> {
  const out = await authRequest('/signup', { email, password });
  if (!out.access_token) {
    // 需要点邮件里的确认链接：此时不落库会话，避免出现"半登录"状态
    return { session: null, needsConfirmation: true };
  }
  const session = await withProfile(toSession(out, email));
  await writeKey(AUTH_KEY, session);
  return { session, needsConfirmation: false };
}

export async function signOut(): Promise<void> {
  await ext.storage.local.remove(AUTH_KEY);
}

export async function recoverPassword(email: string): Promise<void> {
  await authRequest('/recover', { email });
}

/**
 * 保证拿到可用令牌：过期前 2 分钟主动刷新。
 * 刷新失败（refresh token 失效 / 服务端重置）就清空会话，让 UI 回到未登录。
 */
export async function ensureFreshSession(): Promise<AuthSession | null> {
  const session = await getSession();
  if (!session) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (session.expiresAt && session.expiresAt - 120 > nowSec) return session;
  try {
    const out = await authRequest('/refresh', { refresh_token: session.refreshToken });
    if (!out.access_token) throw new Error('refresh 未返回令牌');
    const next = await withProfile(toSession(out, session.email));
    await writeKey(AUTH_KEY, next);
    return next;
  } catch {
    await signOut();
    return null;
  }
}

/** 带鉴权的 API 调用：401 时强制刷新一次再重试 */
async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = await getServerUrl();
  let session = await ensureFreshSession();
  if (!session) throw new Error('未登录');

  const call = (s: AuthSession) => {
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${s.accessToken}`,
    };
    // GET 不带 Content-Type：否则会触发一次没必要的 CORS 预检
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(`${base}${path}`, { ...init, headers });
  };

  let res = await call(session);
  if (res.status === 401) {
    const refreshed = await authRequest('/refresh', {
      refresh_token: session.refreshToken,
    });
    if (!refreshed.access_token) throw new Error('登录已失效，请重新登录');
    session = await withProfile(toSession(refreshed, session.email));
    await writeKey(AUTH_KEY, session);
    res = await call(session);
  }
  if (res.status === 403) {
    const detail = await readError(res);
    throw new Error(`服务器拒绝了请求（403）：${detail}`);
  }
  if (!res.ok) throw new Error(await readError(res));
  return res;
}

// ---------------- 站内消息（0.1.11） ----------------

export interface AnnouncementItem {
  id: number;
  sender_id: string;
  recipient_id: string | null;
  title: string;
  body: string;
  created_at: number;
}

export interface AnnouncementPage {
  items: AnnouncementItem[];
  cursor: number;
}

/** 拉取后台消息：since 是服务端自增 id，严格单调，不会漏消息 */
export async function fetchAnnouncements(since: number): Promise<AnnouncementPage> {
  const res = await apiFetch(`/api/messages?since=${since}&limit=100`, {
    method: 'GET',
  });
  return (await res.json()) as AnnouncementPage;
}

// ---------------- 用户留言（0.1.12） ----------------

export interface FeedbackInput {
  content: string;
  contact_type: 'im' | 'email';
  contact: string;
  client_version: string;
}

/**
 * 提交用户留言：与 apiFetch 不同，这里**刻意不要求登录**。
 *
 * 扩展是本地优先、不登录也能用的，留言窗口不能反过来逼用户先注册。
 * 已登录时带上 Bearer，服务端会额外记下 user_id / 账号邮箱便于回访；
 * 没登录就是匿名提交，靠必填的 contact 承担回访入口。
 * 也不用 ensureFreshSession()：它刷新失败会顺手 signOut()，
 * 对一条「只是想留个言」的请求来说副作用太大。
 */
export async function submitFeedback(input: FeedbackInput): Promise<{ id: number }> {
  const base = await getServerUrl();
  const session = await getSession();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session?.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;
  const res = await fetch(`${base}/api/feedback`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as { id: number };
}

// ---------------- 线上线格式转换 ----------------

function toWireCapture(c: Capture): Record<string, unknown> {
  const full = c.kind === 'full';
  return {
    id: c.id,
    title: c.title,
    url: c.url,
    // 整页收藏只留链接：本地仍有完整快照，云端不需要再存一份
    html: full ? '' : c.html,
    text: full ? '' : c.text,
    kind: c.kind,
    folder_id: c.folderId,
    tags: c.tags,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

function toWireFolder(f: Folder): Record<string, unknown> {
  return {
    id: f.id,
    name: f.name,
    type: f.type,
    created_at: f.createdAt,
    updated_at: f.updatedAt,
  };
}

// ---------------- 上行 ----------------

async function collectChanges(since: number): Promise<WireChange[]> {
  const out: WireChange[] = [];

  const caps = await db.captures.where('updatedAt').above(since).toArray();
  for (const c of caps) {
    // 自带的 readme 收藏是安装时生成的说明，各端都有，不参与同步
    if (c.id === README_ID) continue;
    out.push({ entity: 'capture', op: 'upsert', record: toWireCapture(c) });
  }

  const folders = await db.folders.where('updatedAt').above(since).toArray();
  for (const f of folders) {
    out.push({ entity: 'folder', op: 'upsert', record: toWireFolder(f) });
  }

  const tombs = await db.tombstones.where('updatedAt').above(since).toArray();
  for (const t of tombs) {
    out.push({
      entity: t.entity,
      op: 'delete',
      record: { id: t.id, updated_at: t.updatedAt },
    });
  }

  return out;
}

// ---------------- 下行 ----------------

/**
 * 落地一条云端记录。
 * force=true 用于服务端裁决结果（conflicts）：服务端已经判它赢，就无条件覆盖，
 * 否则本地比时间戳会再次把它挡掉。
 */
async function applyCapture(
  rec: Record<string, unknown>,
  force = false,
): Promise<boolean> {
  const id = String(rec.id ?? '');
  if (!id || id === README_ID) return false;
  const deletedAt = Number(rec.deleted_at ?? 0);
  const incomingUpdated = Number(rec.updated_at ?? 0);
  const local = await db.captures.get(id);

  if (deletedAt) {
    if (!local) {
      await clearTombstone(id);
      return false;
    }
    if (force || incomingUpdated >= local.updatedAt) {
      await purgeCapture(id);
      await clearTombstone(id);
      return true;
    }
    return false;
  }

  if (local && !force && incomingUpdated < local.updatedAt) return false;

  const kind = rec.kind === 'partial' ? 'partial' : 'full';
  const next: Capture = {
    id,
    title: String(rec.title ?? local?.title ?? ''),
    url: String(rec.url ?? local?.url ?? ''),
    // 云端 full 记录没有 html：保留本地快照，别把离线阅读抹掉
    html: String(rec.html ?? '') || local?.html || '',
    text: String(rec.text ?? '') || local?.text || '',
    kind,
    folderId: (rec.folder_id as string | null) ?? null,
    tags: Array.isArray(rec.tags) ? (rec.tags as string[]) : [],
    createdAt: Number(rec.created_at ?? local?.createdAt ?? nowMs()),
    updatedAt: incomingUpdated || nowMs(),
  };
  await db.captures.put(next);
  await clearTombstone(id);
  return true;
}

async function applyFolder(
  rec: Record<string, unknown>,
  force = false,
): Promise<boolean> {
  const id = String(rec.id ?? '');
  if (!id) return false;
  const deletedAt = Number(rec.deleted_at ?? 0);
  const incomingUpdated = Number(rec.updated_at ?? 0);
  const local = await db.folders.get(id);

  if (deletedAt) {
    if (!local) {
      await clearTombstone(id);
      return false;
    }
    if (force || incomingUpdated >= local.updatedAt) {
      await purgeFolder(id);
      await clearTombstone(id);
      return true;
    }
    return false;
  }

  if (local && !force && incomingUpdated < local.updatedAt) return false;

  const type = rec.type === 'tag' ? 'tag' : 'business';
  await db.folders.put({
    id,
    name: String(rec.name ?? local?.name ?? ''),
    type,
    createdAt: Number(rec.created_at ?? local?.createdAt ?? nowMs()),
    updatedAt: incomingUpdated || nowMs(),
  });
  await clearTombstone(id);
  return true;
}

// ---------------- 主流程 ----------------

export async function syncNow(mode?: SyncMode): Promise<SyncReport> {
  const effective = mode ?? (await getSyncMode());
  const session = await ensureFreshSession();
  if (!session) throw new Error('未登录，无法同步');
  // 0.1.11 起注册即可同步：邮箱确认态与付费等级只作展示，不再拦截上传。

  const meta = await getMeta();
  const pushAt = nowMs();
  const changes = effective === 'pull' ? [] : await collectChanges(meta.lastPushAt);

  const res = await apiFetch('/api/sync', {
    method: 'POST',
    body: JSON.stringify({
      mode: effective,
      cursor: effective === 'push' ? 0 : meta.cursor,
      changes,
    }),
  });
  const payload = (await res.json()) as {
    server_cursor?: number;
    changes?: WireChange[];
    conflicts?: { entity: string; id: string; record: Record<string, unknown> }[];
  };

  let pulled = 0;
  let conflicts = 0;
  for (const ch of payload.changes ?? []) {
    const rec = ch.record ?? {};
    const applied =
      ch.entity === 'capture' ? await applyCapture(rec) : await applyFolder(rec);
    if (applied) pulled += 1;
  }
  for (const c of payload.conflicts ?? []) {
    const applied =
      c.entity === 'capture'
        ? await applyCapture(c.record ?? {}, true)
        : await applyFolder(c.record ?? {}, true);
    if (applied) conflicts += 1;
  }

  const report: SyncReport = {
    mode: effective,
    pushed: changes.length,
    pulled,
    conflicts,
    cursor: Number(payload.server_cursor ?? 0),
    at: nowMs(),
  };
  // 已经推送出去的墓碑可以回收：云端已记下删除，本地没必要长期保留一份。
  // 必须在 apply* 之后做 —— apply 里还要靠墓碑判断「云端这条是不是已经删过」。
  if (effective !== 'pull') {
    await db.tombstones.where('updatedAt').belowOrEqual(pushAt).delete();
  }

  // 两个水位线只在「对应的方向真的跑过」时才前进：
  // - cursor 是拉取水位，push-only 时不能动，否则会跳过还没拉下来的记录；
  // - lastPushAt 是上传水位，pull-only 时不能动，否则本地改动会被当成已传过。
  await saveMeta({
    cursor: effective === 'push' ? meta.cursor : report.cursor,
    lastPushAt: effective === 'pull' ? meta.lastPushAt : pushAt,
    lastSyncAt: report.at,
    lastResult: `↑${report.pushed} ↓${report.pulled}${conflicts ? ` ⚠${conflicts}` : ''}`,
  });
  if (pulled || conflicts) await bumpRevision();
  return report;
}

/** 给后台定时任务用：静默失败，不抛异常打断 alarm */
export async function autoSyncQuiet(): Promise<void> {
  if (!(await getAutoSync())) return;
  const session = await getSession();
  if (!session) return;
  try {
    await syncNow('both');
  } catch (e) {
    console.warn('[thothsyn] 自动同步失败', e);
  }
}
