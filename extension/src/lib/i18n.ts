import { KEY_OF, ZH_OF_KEY } from './i18n-keys';

/**
 * 多语言（0.1.6 / debug#3）：用 Chrome 扩展标准的 _locales + chrome.i18n。
 * chrome.i18n 会按**浏览器 UI 语言**自动选最匹配的 locale，回退到
 * manifest.default_locale —— 这就是「语言跟随浏览器系统语言」，扩展不需要
 * 自己判断语言、也不需要在设置页加语言开关。
 *
 * 源码里的 UI 文案保留中文原文：运行时用 KEY_OF 反查 i18n key，
 * 再交给 chrome.i18n.getMessage() 取当前语言译文。没有 chrome 上下文时
 * （函数级回归测试）退回中文原文，保证纯函数可测。
 */

function subsOf(values: Array<string | number>): string[] {
  return values.map(String);
}

function fill(text: string, subs: string[]): string {
  return subs.reduce(
    (s, value, i) => s.split(`$${i + 1}`).join(value),
    text,
  );
}

/** 取当前语言的译文；取不到时退回中文原文 */
export function message(key: string, ...values: Array<string | number>): string {
  const subs = subsOf(values);
  try {
    if (typeof chrome !== 'undefined' && chrome.i18n?.getMessage) {
      const localized = chrome.i18n.getMessage(key, subs);
      if (localized) return localized;
    }
  } catch {
    // 非扩展上下文，走中文兜底
  }
  return fill(ZH_OF_KEY[key] ?? key, subs);
}

/** 动态拼装的文案：传中文原文 + 位置参数，例如 t('已选 $1 个', n) */
export function t(zh: string, ...values: Array<string | number>): string {
  const key = KEY_OF[zh];
  return key ? message(key, ...values) : fill(zh, subsOf(values));
}

/** 浏览器 UI 语言，例如 zh-CN / en-US */
export function uiLanguage(): string {
  try {
    if (typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage) {
      return chrome.i18n.getUILanguage();
    }
  } catch {
    // 忽略
  }
  return (typeof navigator !== 'undefined' && navigator.language) || 'zh-CN';
}

/**
 * 数据层保持稳定：默认文件夹名是存进 IndexedDB 的数据，不随语言改写，
 * 否则切换语言会让归属查找和 0.1.5 的历史迁移失效。只在**显示时**映射。
 * 用户自建文件夹原样显示，不翻译。
 */
export function folderLabel(name: string): string {
  const seedKeys: Record<string, string> = {
    未分类: 'folderUncategorized',
    归档: 'folderArchive',
    等待阅读: 'folderUncategorized',
  };
  const key = seedKeys[name];
  return key ? message(key) : name;
}

/**
 * 把一片 DOM 里的静态文案换成当前语言。render() 重建 DOM 后再调一次即可。
 * 含用户数据的容器必须标 data-no-i18n，否则收藏标题碰巧叫「设置」会被误翻。
 */
export function applyI18n(root: ParentNode = document): void {
  if (typeof document === 'undefined') return;

  // content script 只对自己的片段 / shadow root 调用，绝不能改宿主网页的
  // <html lang> 或 document.title。
  if (root === document) {
    document.documentElement.lang = uiLanguage();
    const titleKey = KEY_OF[document.title];
    if (titleKey) document.title = message(titleKey);
  }

  const query = (root as ParentNode).querySelectorAll?.bind(root);
  if (query) {
    query('[title],[aria-label],[placeholder],[alt]').forEach((el) => {
      if (el.closest('[data-no-i18n]')) return;
      for (const attr of ['title', 'aria-label', 'placeholder', 'alt']) {
        const value = el.getAttribute(attr);
        if (!value) continue;
        const key = KEY_OF[value];
        if (key) el.setAttribute(attr, message(key));
      }
    });
  }

  // TreeWalker 只遍历文本节点，不动元素结构，也不碰属性值
  const walker = document.createTreeWalker(
    root as Node,
    // 4 === NodeFilter.SHOW_TEXT；不直接引用常量以兼容无 DOM 全局的测试环境
    4,
  );
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const parent = node.parentElement;
    if (!parent || parent.closest('[data-no-i18n]')) continue;
    if (parent.closest('script,style,noscript,template')) continue;
    const text = node.textContent ?? '';
    const normalized = text.replace(/\s+/g, ' ').trim();
    const key = KEY_OF[normalized];
    if (!key) continue;
    const leading = /^\s*/.exec(text)?.[0] ?? '';
    const trailing = /\s*$/.exec(text)?.[0] ?? '';
    node.textContent = leading + message(key) + trailing;
  }
}
