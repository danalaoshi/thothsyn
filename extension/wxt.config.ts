import { defineConfig } from 'wxt';

// Thothsyn — 仅 Chrome (Manifest V3)。
// 收藏库是「网页内注入的左侧抽屉」，iframe 指向 library.html：
// 固定在左侧、默认自动隐藏（usercase.md 第 22 行）。
// 不使用 Chrome 原生 sidePanel：左右位置只能由用户在浏览器设置里指定，
// 且 API 不提供自动隐藏能力。
const ICONS = {
  16: 'icon/a/16.png',
  32: 'icon/a/32.png',
  48: 'icon/a/48.png',
  128: 'icon/a/128.png',
};

export default defineConfig({
  srcDir: 'src',
  entrypointsDir: 'entrypoints',
  modules: [],
  manifest: {
    // __MSG_*__ 由 Chrome 按浏览器 UI 语言从 public/_locales 自动替换；
    // default_locale 是找不到匹配语言时的兜底。
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    version: '0.1.10',
    icons: ICONS,
    permissions: [
      'storage',
      'contextMenus',
      'activeTab',
      'scripting',
      'bookmarks',
      // 每日自动同步：MV3 的 Service Worker 会被回收，setTimeout/setInterval
      // 都不可靠，只有 alarms 能在 SW 休眠后仍按时唤醒。
      'alarms',
      // 离线资源（图片/CSS/字体/脚本存档）会长期累积在 IndexedDB；
      // 同时豁免配额限制与浏览器逐出
      'unlimitedStorage',
    ],
    host_permissions: ['<all_urls>'],
    // 允许任意网页把 library.html 作为 iframe 加载（抽屉内容源）
    web_accessible_resources: [
      { resources: ['library.html'], matches: ['<all_urls>'] },
    ],
    action: {
      default_title: '__MSG_actionTitle__',
      default_icon: ICONS,
    },
  },
  // WXT 会按 options/ 入口目录生成 options_ui 并覆盖 manifest 里的同名配置，
  // 只能在生成后改写：独立标签页才能被「完成」按钮关闭；嵌在
  // chrome://extensions 内的 options iframe 无法自行关闭。
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      if (manifest.options_ui) manifest.options_ui.open_in_tab = true;
    },
  },
});
