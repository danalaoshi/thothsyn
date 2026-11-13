/**
 * 跨浏览器扩展 API（0.1.13）。
 *
 * WXT 官方把 chrome / browser 两个全局合并成同一个对象，实现是：
 *   globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome
 * 见 https://wxt.dev/guide/essentials/extension-apis
 *
 * 这里按同样规则做一份零依赖实现，原因有三：
 * - Chrome MV3 拿到 chrome（异步方法返回 Promise，与现有 await 代码一致）；
 * - Firefox 拿到原生 browser（Promise 风格）。MDN 明确说明 Firefox 的
 *   chrome 命名空间为兼容 Chrome 而提供、只支持回调，直接 await 会得到
 *   undefined；本项目大量 await，必须走 browser 才不会全线崩掉；
 * - 函数级 selftest 在 Node 里以 CommonJS 加载真实 .ts 源文件，
 *   global.chrome 是内存模拟对象，自建模块可避免依赖 wxt/browser 的
 *   ESM 子路径在 CJS 下的解析问题。
 *
 * 类型沿用 @types/chrome：两端 API 形状一致。仅 action / contextMenus
 * 在 Firefox 里另有 browserAction / menus 名称，调用处自行兜底。
 */
type ExtGlobal = typeof chrome;

const g = globalThis as unknown as {
  browser?: ExtGlobal;
  chrome?: ExtGlobal;
};

// 跨浏览器 API 选择（0.1.16 修复 Firefox 下 ext.tabs 为 undefined）。
// 早期写法用 `browser?.runtime?.id ? browser : chrome` 判断，但在 Firefox 下
// 被注入到普通网页的扩展页面 iframe（library.html）里 runtime.id 可能为空，
// 于是回退到不完整的 chrome 全局——而 Firefox 的 chrome 兼容层没有 tabs，
// 导致所有 ext.tabs.* 调用崩溃（点击收藏链接 / 设置按钮都无反应）。
// 改为「直接挑选第一个拥有 tabs 的全局」：Firefox 的 browser 一定有 tabs，
// Chrome 的 chrome 一定有 tabs，都能命中；不再依赖 runtime.id 是否为空。
function pickExt(): ExtGlobal {
  const candidates = [g.browser, g.chrome].filter(Boolean) as ExtGlobal[];
  for (const c of candidates) {
    if (c && (c as { tabs?: unknown }).tabs) return c;
  }
  return (g.browser || g.chrome) as ExtGlobal;
}

export const ext: ExtGlobal = pickExt();

/**
 * 在浏览器里新建标签页打开一个 URL。
 *
 * Chrome 与 Firefox 顶层扩展页面、content script 里 `ext.tabs` 都存在，
 * 直接 `tabs.create` 即可。唯独 **被注入到普通网页的扩展页面 iframe
 * （library.html）**，Firefox 下 `browser` 全局缺失、`chrome.tabs` 又是
 * undefined（见 0.1.16 修复说明），本上下文无法自己开标签页。
 * 此时改走 `runtime.sendMessage` 把活交给后台脚本——后台处于顶层扩展
 * 上下文，`browser.tabs` 一定可用。这样既修好 Firefox 收藏库点开网页 /
 * 设置页的问题，又不破坏其它上下文的直连路径。
 */
export async function openTab(url: string): Promise<void> {
  const tabsLike = ext as unknown as {
    tabs?: { create?: (arg: { url: string }) => unknown };
  };
  if (tabsLike.tabs && tabsLike.tabs.create) {
    await (tabsLike.tabs.create({ url }) as Promise<unknown> | void);
    return;
  }
  // 兜底：交给后台开标签页
  await ext.runtime.sendMessage({
    __thothOpenTab: true,
    url,
  } as unknown as Parameters<typeof ext.runtime.sendMessage>[0]);
}
