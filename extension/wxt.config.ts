import { defineConfig } from 'wxt';

// Thothsyn — Chrome / Firefox 双目标，统一用 Manifest V3。
// Firefox 目标必须显式加 --mv3：WXT 默认给 Firefox 生成 MV2。
// 见 package.json 的 dev:firefox / build:firefox / zip:firefox。
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
    version: '0.1.18',
    icons: ICONS,
    permissions: [
      'storage',
      'contextMenus',
      'activeTab',
      'scripting',
      'bookmarks',
      // 每日自动同步 + 后台消息轮询：MV3 的 Service Worker 会被回收，
      // setTimeout/setInterval 都不可靠，只有 alarms 能在 SW 休眠后仍按时唤醒。
      'alarms',
      // 后台下发站内消息时弹桌面通知（0.1.11）
      'notifications',
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
    'build:manifestGenerated': (wxt, manifest) => {
      if (manifest.options_ui) manifest.options_ui.open_in_tab = true;

      // Firefox 专属字段不能在 manifest 顶层直接写：WXT 的 manifest 类型
      // 基于 @types/chrome，不认识 browser_specific_settings。
      // 依据 MDN：gecko.id 是 MV3 签名必需；2025-11-03 起提交 AMO 的新扩展
      // 还需声明数据收集。本项目默认纯本地，上传（云同步 / 留言）全部由
      // 用户主动触发，故 required=none、把可能上传的数据类型放 optional。
      // 【推断】这份清单按 0.1.13 现有字段整理，正式上架 AMO 前需按实际
      // 数据流和隐私政策复核，不要直接照抄。
      const browser = (wxt.config as unknown as { browser?: string }).browser;
      if (browser === 'firefox') {
        (manifest as unknown as Record<string, unknown>).browser_specific_settings =
          {
            gecko: {
              id: 'thothsyn@local',
              data_collection_permissions: {
                required: ['none'],
                optional: [
                  'authenticationInfo',
                  'bookmarksInfo',
                  'personallyIdentifyingInfo',
                  'personalCommunications',
                  'technicalAndInteraction',
                  'websiteContent',
                ],
              },
            },
          };
      }
    },
  },
});
