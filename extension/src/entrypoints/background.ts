import { ext } from '../lib/webext';
import { defineBackground } from 'wxt/utils/define-background';
import { db } from '../db/database';
import { defaultBusinessFolder, ensureSeed } from '../lib/seed';
import { ensureReadmeCapture } from '../lib/readme';
import { message, t } from '../lib/i18n';
import {
  enqueueAssets,
  extractResourceUrls,
  runAssetQueue,
} from '../lib/assets';
import { bumpRevision, getBool, ICON_BLINK_KEY } from '../lib/settings';
import { addCapture } from '../lib/repo';
import { autoSyncQuiet, AUTO_SYNC_KEY, getAutoSync } from '../lib/sync';
import {
  pollAnnouncementsQuiet,
  wireAnnouncementClicks,
} from '../lib/announcements';
import type { Capture } from '../types';
import type {
  AssetsChangedMsg,
  CaptureFullResult,
  IconBlinkStateMsg,
  LibraryState,
  LibraryStateMsg,
  PartialResultMsg,
  RuntimeMessage,
} from '../lib/messages';

const LIB_KEY = 'thothLibrary';

/**
 * 哪些页面能注入 content script。
 * chrome://、chrome-extension://、view-source:、data: 等页面注入必然失败
 * （"Cannot access a chrome:// URL"）—— 这是**预期行为**，直接走收藏库兜底，
 * 不应该往控制台打一条 error（debug#4 前半段的刷屏来源）。
 */
function isInjectableUrl(url?: string): boolean {
  if (!url) return false;
  if (url === 'about:blank' || url.startsWith('about:blank#')) return true;
  return /^(https?|file):/i.test(url);
}

const DEFAULT_LIB_STATE: LibraryState = {
  open: false,
  pinned: false,
  width: 360,
};

/** 两帧静态 PNG：Chrome 不支持动画图标，用程序化换帧模拟「主色来回切换」 */
const ICON_FRAMES = {
  a: {
    16: 'icon/a/16.png',
    32: 'icon/a/32.png',
    48: 'icon/a/48.png',
    128: 'icon/a/128.png',
  },
  b: {
    16: 'icon/b/16.png',
    32: 'icon/b/32.png',
    48: 'icon/b/48.png',
    128: 'icon/b/128.png',
  },
} as const;
/** 换帧最小间隔，防止多个可见标签页同时心跳导致抖动 */
const ICON_TICK_MIN_MS = 700;

export default defineBackground(() => {
  // Firefox 把 action / contextMenus 也提供过 browserAction / menus 两个名字；
  // 这里在入口内做一次特征探测，Chrome 与 Firefox MV3 都拿到同一个 API 形状。
  // 参考 WXT「Feature Detection」：(browser.action ?? browser.browser_action)。
  const actionApi = (ext.action ??
    (ext as unknown as { browserAction?: typeof chrome.action }).browserAction)!;
  const menusApi = (ext.contextMenus ??
    (ext as unknown as { menus?: typeof chrome.contextMenus }).menus)!;

  // ---- 播种默认业务文件夹 + readme 收藏（幂等） ----
  // SW 每次唤醒都会跑到这里，因此「全新安装」和「升级到新版本」都会补上
  // readme；内容有变化时才写库，不会每次唤醒都触发收藏库刷新。
  ensureSeed().catch((e) => console.error('[thothsyn] seed failed', e));
  void ensureReadmeCapture().catch((e) =>
    console.error('[thothsyn] readme 收藏初始化失败', e),
  );

  let iconBlink = true;
  let iconFrame: 'a' | 'b' = 'a';
  let lastIconTick = 0;

  function applyIconFrame(frame: 'a' | 'b'): void {
    iconFrame = frame;
    void Promise.resolve(
      actionApi.setIcon({ path: ICON_FRAMES[frame] }),
    ).catch(() => {});
  }

  function broadcastIconState(blink: boolean): void {
    const msg: IconBlinkStateMsg = { type: 'ICON_BLINK_STATE', blink };
    void Promise.resolve(ext.tabs.query({}))
      .then((tabs) => {
        for (const t of tabs) {
          if (t.id == null) continue;
          void Promise.resolve(ext.tabs.sendMessage(t.id, msg)).catch(
            () => {},
          );
        }
      })
      .catch(() => {});
  }

  void getBool(ICON_BLINK_KEY, true).then((v) => {
    iconBlink = v;
    if (!v) applyIconFrame('a');
    // 启动后把真实状态补发给所有标签页：避免内容脚本在读取完成前
    // 拿到默认 true 而白跑心跳（用户其实关了闪烁）。
    broadcastIconState(v);
  });

  // 设置页改开关 → storage 事件 → 缓存 + 广播给所有标签页（关闭时回到静态帧）
  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[ICON_BLINK_KEY]) return;
    iconBlink = changes[ICON_BLINK_KEY].newValue === true;
    if (!iconBlink) applyIconFrame('a');
    broadcastIconState(iconBlink);
  });

  // ---- 每日自动同步：MV3 只有 alarms 能在 SW 休眠后按时唤醒 ----
  // 开关存在 ext.storage，改开关后由 storage 监听对齐 alarm，避免两处状态不一致。
  const SYNC_ALARM = 'thoth-daily-sync';

  async function reconcileSyncAlarm(): Promise<void> {
    const on = await getAutoSync();
    const existing = await ext.alarms.get(SYNC_ALARM);
    if (on && !existing) {
      // 延迟 1 分钟先跑一次：用户刚打开开关时不该等一整天
      ext.alarms.create(SYNC_ALARM, {
        delayInMinutes: 1,
        periodInMinutes: 60 * 24,
      });
    } else if (!on && existing) {
      await ext.alarms.clear(SYNC_ALARM);
    }
  }

  ext.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM) void autoSyncQuiet();
  });
  void reconcileSyncAlarm().catch(() => {});

  // 设置页改「每日自动同步」开关 → 立刻对齐 alarm
  ext.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[AUTO_SYNC_KEY]) {
      void reconcileSyncAlarm().catch(() => {});
    }
  });

  // ---- 后台消息轮询（0.1.11）----
  // 独立 alarm，故意不与「每日自动同步」开关绑定：用户关掉自动同步，
  // 后台发的通知也必须能到达。未登录时 pollAnnouncements() 会直接跳过。
  const MESSAGE_ALARM = 'thoth-message-poll';

  async function reconcileMessageAlarm(): Promise<void> {
    const existing = await ext.alarms.get(MESSAGE_ALARM);
    if (!existing) {
      // 首次 1 分钟后跑一次，之后每小时一次；设置页打开时还会主动拉一次
      ext.alarms.create(MESSAGE_ALARM, {
        delayInMinutes: 1,
        periodInMinutes: 60,
      });
    }
  }

  ext.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === MESSAGE_ALARM) void pollAnnouncementsQuiet();
  });
  wireAnnouncementClicks();
  void reconcileMessageAlarm().catch(() => {});
  void pollAnnouncementsQuiet();

  // ---- 离线资源：后台下载队列（不阻塞保存主链路） ----
  function notifyAssetsChanged(): void {
    void Promise.resolve(
      ext.runtime.sendMessage({
        type: 'ASSETS_CHANGED',
      } satisfies AssetsChangedMsg),
    ).catch(() => {});
  }

  /**
   * 调试反馈 #4：预览排版差的外链 CSS 也要存本地。
   * 图片、样式表、脚本一起入队；脚本只存档、绝不注入预览（sandbox 安全规则）。
   */
  async function scheduleOfflineAssets(html: string, url: string): Promise<void> {
    const res = extractResourceUrls(html, url);
    await Promise.all([
      enqueueAssets(res.images, 'image'),
      enqueueAssets(res.styles, 'style'),
      enqueueAssets(res.scripts, 'script'),
      enqueueAssets(res.fonts, 'font'),
    ]);
    void runAssetQueue(notifyAssetsChanged);
  }

  /**
   * 升级到 0.1.4 前保存的收藏只有图片记录（0.1.3），或完全没有（更早版本）。
   * 0.1.5 又把内联 CSS 的字体单独分流，因此换新的打标再补一次，
   * 让历史收藏的字体也有机会离线化；settings 打标防重复。
   */
  async function backfillOfflineAssets(): Promise<void> {
    try {
      const key = 'assetsBackfill.0.1.5';
      const done = await db.settings.get(key);
      if (done?.value) return;
      const caps = await db.captures.toArray();
      const images = new Set<string>();
      const styles = new Set<string>();
      const scripts = new Set<string>();
      const fonts = new Set<string>();
      for (const c of caps) {
        if (!c.html) continue;
        const res = extractResourceUrls(c.html, c.url);
        for (const u of res.images) images.add(u);
        for (const u of res.styles) styles.add(u);
        for (const u of res.scripts) scripts.add(u);
        for (const u of res.fonts) fonts.add(u);
      }
      await Promise.all([
        enqueueAssets([...images], 'image'),
        enqueueAssets([...styles], 'style'),
        enqueueAssets([...scripts], 'script'),
        enqueueAssets([...fonts], 'font'),
      ]);
      await db.settings.put({ key, value: true });
      void runAssetQueue(notifyAssetsChanged);
    } catch (e) {
      console.error('[thothsyn] 历史收藏补资源失败', e);
    }
  }

  // MV3 Service Worker 随时可能被终止：每次唤醒都从落库的 pending 续跑
  void runAssetQueue(notifyAssetsChanged).catch((e) =>
    console.error('[thothsyn] 离线资源续跑失败', e),
  );

  // ---- 安装 / 更新：重建右键菜单 ----
  ext.runtime.onInstalled.addListener(async () => {
    applyIconFrame('a');
    await menusApi.removeAll();
    menusApi.create({
      id: 'thoth-save-full',
      title: message('menuSaveFull'),
      contexts: ['action'],
    });
    menusApi.create({
      id: 'thoth-save-partial',
      title: message('menuSavePartial'),
      contexts: ['action'],
    });
    menusApi.create({
      id: 'thoth-open-library',
      title: message('menuOpenLibrary'),
      contexts: ['action'],
    });
    void backfillOfflineAssets();
    // 升级时同步一次 readme 正文（模块内去重，不会和顶层调用重复写库）
    void ensureReadmeCapture().catch((e) =>
      console.error('[thothsyn] readme 收藏同步失败', e),
    );
  });

  ext.runtime.onStartup.addListener(() => applyIconFrame('a'));

  // ---- 收藏库状态：ext.storage.local 持久化，背景页统一广播 ----
  async function getLibraryState(): Promise<LibraryState> {
    const raw = await ext.storage.local.get(LIB_KEY);
    const saved = raw[LIB_KEY] as Partial<LibraryState> | undefined;
    const state: LibraryState = { ...DEFAULT_LIB_STATE, ...(saved ?? {}) };
    state.width = Math.min(
      Math.max(Number(state.width) || DEFAULT_LIB_STATE.width, 280),
      720,
    );
    return state;
  }

  function broadcastLibrary(state: LibraryState, reveal = false): void {
    const msg: LibraryStateMsg = { type: 'LIBRARY_STATE', state, reveal };
    void Promise.resolve(ext.tabs.query({}))
      .then((tabs) => {
        for (const t of tabs) {
          if (t.id == null) continue;
          void Promise.resolve(ext.tabs.sendMessage(t.id, msg)).catch(
            () => {},
          );
        }
      })
      .catch((e) => console.error('[thothsyn] 收藏库状态广播失败', e));
  }

  async function setLibraryState(
    patch: Partial<LibraryState>,
    reveal = false,
  ): Promise<void> {
    const next: LibraryState = { ...(await getLibraryState()), ...patch };
    await ext.storage.local.set({ [LIB_KEY]: next });
    broadcastLibrary(next, reveal);
  }

  // ---- 入库：构造一条 Capture 并广播 ----
  async function saveCapture(data: {
    title: string;
    url: string;
    html: string;
    text: string;
    kind: 'full' | 'partial';
  }): Promise<void> {
    // debug#3：默认业务文件夹是「未分类」，按创建顺序取而不是按主键顺序，
    // 保证用户改过文件夹顺序后新收藏仍落到默认分类。
    const defaultFolder = await defaultBusinessFolder();
    const capture = await addCapture({
      id: crypto.randomUUID(),
      title: data.title || data.url || t('未命名'),
      url: data.url,
      html: data.html,
      text: data.text,
      kind: data.kind,
      folderId: defaultFolder?.id ?? null,
      tags: [],
      createdAt: Date.now(),
    });

    // debug#2：主通道改成 storage 数据版本号，对网页内扩展 iframe 可靠投递；
    // runtime 消息保留为冗余（收藏库没打开时无接收端，属正常）。
    void bumpRevision().catch(() => {});
    void Promise.resolve(
      ext.runtime.sendMessage({ type: 'CAPTURE_SAVED', id: capture.id }),
    ).catch(() => {});

    // 外链资源后台下载：入队即返回，不等待网络
    void scheduleOfflineAssets(capture.html, capture.url).catch((e) =>
      console.error('[thothsyn] 离线资源队列失败', e),
    );
  }

  /**
   * 安装扩展前已打开的标签页不会自动注入 content script。
   * 先 PING 探活；确实没有接收端时手动注入打包产物。
   */
  async function ensureContentScript(tabId: number): Promise<boolean> {
    // 先按 URL 预检：chrome:// 等页面必然注入失败，静默交给兜底即可。
    // 不预检就会像 0.1.6 那样反复刷 "Cannot access a chrome:// URL"。
    let tab: chrome.tabs.Tab | undefined;
    try {
      tab = await ext.tabs.get(tabId);
    } catch {
      return false;
    }
    if (!isInjectableUrl(tab.url)) return false;

    try {
      await ext.tabs.sendMessage(tabId, { type: 'THOTH_PING' });
      return true;
    } catch {
      // 无接收端，继续注入
    }
    try {
      await ext.scripting.executeScript({
        target: { tabId },
        files: ['content-scripts/content.js'],
      });
      return true;
    } catch (err) {
      // 走到这里才是真正的意外失败（扩展刚重载、页面刚导航等），保留日志
      console.error('[thothsyn] content script 注入失败', err);
      return false;
    }
  }

  /**
   * 页面无法注入脚本时的兜底：用普通标签页展示同一个 library.html。
   * library.html 会识别「自己就是顶层窗口」，收敛成 360px 左侧栏而不是铺满整页
   * （debug#1）；重复打开时复用同一个标签页，避免堆一堆。
   */
  let libraryTabId: number | null = null;
  function openLibraryInTab(): void {
    const url = ext.runtime.getURL('library.html');
    const create = () => {
      void Promise.resolve(ext.tabs.create({ url }))
        .then((t) => {
          libraryTabId = t.id ?? null;
        })
        .catch(() => {});
    };
    if (libraryTabId == null) {
      create();
      return;
    }
    const id = libraryTabId;
    void Promise.resolve(ext.tabs.get(id))
      .then(() => ext.tabs.update(id, { active: true }))
      .catch(() => {
        libraryTabId = null;
        create();
      });
  }

  // ---- 图标单击 = 整页保存 ----
  actionApi.onClicked.addListener(async (tab) => {
    if (!tab.id) return;
    try {
      if (!(await ensureContentScript(tab.id))) {
        flashBadge(tab.id, '!');
        return;
      }
      const res = (await ext.tabs.sendMessage(tab.id, {
        type: 'CAPTURE_FULL',
      })) as CaptureFullResult | undefined;
      if (!res) {
        flashBadge(tab.id, '!');
        return;
      }
      await saveCapture({ ...res, kind: 'full' });
      flashBadge(tab.id, '✓');
    } catch (err) {
      console.error('[thothsyn] 整页保存失败', err);
      flashBadge(tab.id, '!');
    }
  });

  // ---- 右键菜单点击 ----
  menusApi.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === 'thoth-open-library') {
      const tabId = tab?.id;
      if (tabId == null) return;
      void ensureContentScript(tabId).then((ok) => {
        if (!ok) {
          openLibraryInTab();
          return;
        }
        void setLibraryState({ open: true, pinned: false }, true);
      });
      return;
    }
    if (!tab?.id) return;
    if (info.menuItemId === 'thoth-save-full') {
      try {
        if (!(await ensureContentScript(tab.id))) return;
        const res = (await ext.tabs.sendMessage(tab.id, {
          type: 'CAPTURE_FULL',
        })) as CaptureFullResult | undefined;
        if (res) await saveCapture({ ...res, kind: 'full' });
      } catch (err) {
        console.error('[thothsyn] 整页保存失败', err);
      }
    } else if (info.menuItemId === 'thoth-save-partial') {
      try {
        if (!(await ensureContentScript(tab.id))) return;
        await ext.tabs.sendMessage(tab.id, { type: 'START_PARTIAL_SELECT' });
      } catch (err) {
        console.error('[thothsyn] 部分保存启动失败', err);
      }
    }
  });

  // ---- 运行时消息 ----
  ext.runtime.onMessage.addListener(
    (msg: RuntimeMessage, _sender, sendResponse) => {
      // Firefox 下被注入到普通网页的扩展页面 iframe（library.html）里
      // browser 全局缺失、chrome.tabs 为 undefined，无法自己开标签页。
      // 这里在顶层扩展上下文里代劳（0.1.17 修复）。
      const openTabReq = (msg as unknown) as {
        __thothOpenTab?: boolean;
        url?: string;
      };
      if (openTabReq.__thothOpenTab && openTabReq.url) {
        void Promise.resolve(ext.tabs.create({ url: openTabReq.url })).catch(
          () => {},
        );
        sendResponse({ ok: true });
        return true;
      }
      if (msg?.type === 'PARTIAL_RESULT') {
        const data = msg as PartialResultMsg;
        saveCapture({
          title: data.title,
          url: data.url,
          html: data.html,
          text: data.text,
          kind: 'partial',
        }).catch((e) => console.error('[thothsyn] 部分保存入库失败', e));
        return;
      }
      if (msg?.type === 'LIBRARY_GET_STATE') {
        void getLibraryState()
          .then(sendResponse)
          .catch(() => sendResponse(DEFAULT_LIB_STATE));
        return true;
      }
      if (msg?.type === 'LIBRARY_SET_STATE') {
        void setLibraryState(msg.patch ?? {});
      }
      if (msg?.type === 'ICON_GET_STATE') {
        sendResponse({ blink: iconBlink });
        return;
      }
      if (msg?.type === 'ICON_TICK') {
        if (!iconBlink) return;
        const now = Date.now();
        if (now - lastIconTick < ICON_TICK_MIN_MS) return;
        lastIconTick = now;
        applyIconFrame(iconFrame === 'a' ? 'b' : 'a');
      }
    },
  );

  // ---- 图标角标反馈 ----
  function flashBadge(tabId: number, text: string) {
    actionApi.setBadgeText({ tabId, text });
    actionApi.setBadgeBackgroundColor({
      tabId,
      color: text === '✓' ? '#2e9e4f' : '#c0392b',
    });
    setTimeout(() => actionApi.setBadgeText({ tabId, text: '' }), 1500);
  }
});
