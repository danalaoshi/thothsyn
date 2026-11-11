/**
 * 共享的轻量设置与「数据版本号」。
 *
 * 为什么需要版本号：收藏库是嵌在网页里的扩展 iframe，Service Worker 的
 * chrome.runtime.sendMessage 对它投递不稳定（debug 第 2 条「点了收藏侧边栏
 * 没变」的根因）。chrome.storage.onChanged 对**所有扩展上下文**可靠，因此
 * 任何写入 Dexie 的地方都顺手写一个自增版本号，UI 监听它再重读数据库。
 * runtime 消息保留为冗余通道，不再作为唯一依赖。
 */

/** 任何收藏/文件夹/导入/删除写入后 bump，触发各 UI 刷新 */
export const REVISION_KEY = 'thothRevision';
/** 删除收藏时是否需要二次确认（默认 false = 直接删除） */
export const DELETE_CONFIRM_KEY = 'thothDeleteConfirm';
/** 工具栏图标是否双色闪烁（默认 true） */
export const ICON_BLINK_KEY = 'thothIconBlink';

export async function bumpRevision(): Promise<void> {
  // 加随机后缀，保证同一毫秒内连续写入也能触发 onChanged
  await chrome.storage.local.set({
    [REVISION_KEY]: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
  });
}

export async function getBool(
  key: string,
  fallback: boolean,
): Promise<boolean> {
  try {
    const raw = await chrome.storage.local.get(key);
    return typeof raw[key] === 'boolean' ? (raw[key] as boolean) : fallback;
  } catch {
    return fallback;
  }
}

export async function setBool(key: string, value: boolean): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

/** 纯函数：便于函数级测试两条分支，也避免 undefined 被当成 true */
export function needsDeleteConfirm(value: unknown): boolean {
  return value === true;
}
