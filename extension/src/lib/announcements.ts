import { ext } from './webext';
/**
 * 后台站内消息（0.1.11）。
 *
 * 通道是「拉取」而不是浏览器 Push：服务端没有推送服务，MV3 里 ext.gcm
 * 也早已不可用。扩展用一个独立的 alarms 定时唤醒 Service Worker，按服务端
 * 自增 id 做增量拉取，拉到新消息写进 storage.local 并弹桌面通知。
 *
 * 安全：title / body 一律当纯文本。通知 API 本身不解析 HTML，设置页用
 * textContent 渲染，绝不把后台内容拼进 iframe 或 srcdoc。
 */
import {
  fetchAnnouncements,
  getSession,
  type AnnouncementItem,
} from './sync';

export const ANNOUNCEMENTS_KEY = 'thothAnnouncements';
export const ANNOUNCEMENTS_CURSOR_KEY = 'thothAnnouncementsCursor';

const MAX_ITEMS = 50;
const NOTIFY_PREFIX = 'thoth-msg-';

export async function getAnnouncements(): Promise<AnnouncementItem[]> {
  const raw = await ext.storage.local.get(ANNOUNCEMENTS_KEY);
  const items = raw[ANNOUNCEMENTS_KEY];
  return Array.isArray(items) ? (items as AnnouncementItem[]) : [];
}

export async function getAnnouncementsCursor(): Promise<number> {
  const raw = await ext.storage.local.get(ANNOUNCEMENTS_CURSOR_KEY);
  return Number(raw[ANNOUNCEMENTS_CURSOR_KEY]) || 0;
}

/** 只清展示列表，不动水位：否则会把旧消息重新拉一遍、重复弹通知 */
export async function clearAnnouncements(): Promise<void> {
  await ext.storage.local.set({ [ANNOUNCEMENTS_KEY]: [] });
}

async function notify(item: AnnouncementItem): Promise<void> {
  try {
    await ext.notifications.create(`${NOTIFY_PREFIX}${item.id}`, {
      type: 'basic',
      iconUrl: ext.runtime.getURL('icon/a/128.png'),
      title: String(item.title ?? '').slice(0, 200) || 'Thothsyn 消息',
      // 通知正文是纯文本，不加载任何 URL、不解析 HTML
      message: String(item.body ?? '').slice(0, 300) || '打开设置页查看消息',
      priority: 1,
    });
  } catch (e) {
    // 通知权限被系统关掉 / 该 Chromium 变体不支持：消息仍已落库，不影响主链路
    console.warn('[thothsyn] 桌面通知不可用', e);
  }
}

/** 返回本次新收到的条数；未登录时直接跳过，不打扰用户 */
export async function pollAnnouncements(): Promise<number> {
  const session = await getSession();
  if (!session) return 0;

  const since = await getAnnouncementsCursor();
  const page = await fetchAnnouncements(since);
  const items = Array.isArray(page.items) ? page.items : [];
  const cursor = Math.max(Number(page.cursor) || 0, since);

  const existing = await getAnnouncements();
  const known = new Set(existing.map((x) => Number(x.id)));
  const fresh = items.filter(
    (x) => x && Number.isFinite(Number(x.id)) && !known.has(Number(x.id)),
  );

  if (fresh.length) {
    const merged = [...fresh, ...existing]
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, MAX_ITEMS);
    await ext.storage.local.set({
      [ANNOUNCEMENTS_KEY]: merged,
      [ANNOUNCEMENTS_CURSOR_KEY]: Math.max(cursor, ...fresh.map((x) => Number(x.id))),
    });
    for (const item of fresh) await notify(item);
  } else if (cursor > since) {
    // 服务端跳过了定向给别人的消息：水位照样前进，避免每次都全量扫
    await ext.storage.local.set({ [ANNOUNCEMENTS_CURSOR_KEY]: cursor });
  }
  return fresh.length;
}

/** 给后台定时任务用：静默失败，不抛异常打断 alarm */
export async function pollAnnouncementsQuiet(): Promise<void> {
  try {
    await pollAnnouncements();
  } catch (e) {
    console.warn('[thothsyn] 消息轮询失败', e);
  }
}

/** 点通知打开设置页的消息区，顺手把这条通知收掉 */
export function wireAnnouncementClicks(): void {
  ext.notifications.onClicked.addListener((id) => {
    if (!id.startsWith(NOTIFY_PREFIX)) return;
    void Promise.resolve(
      ext.tabs.create({ url: ext.runtime.getURL('options.html') }),
    ).catch(() => {});
    void Promise.resolve(ext.notifications.clear(id)).catch(() => {});
  });
}
