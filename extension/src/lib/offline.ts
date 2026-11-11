import { db } from '../db/database';
import {
  absoluteAssetUrl,
  attrValue,
  blobToDataUrl,
  extractCssUrls,
  extractResourceUrls,
} from './assets';

/**
 * 预览用的「纯离线 HTML」。
 *
 * v0.1.3：外链图片换成 assets 表里已下载的本地 Blob（data: URL）。
 * v0.1.4：外链 CSS 也存本地并内联进 <head>，同时把 CSS 内 url() 指向的
 *         图片/字体换成 data: URL —— 这是 debug#4「预览排版差」的真正修法。
 *
 * 安全：CSP `default-src 'none'` + sandbox="" 双层不变。脚本**只存档不注入**，
 * 快照始终按不可信输入处理；这里用 DOMParser 得到的只是 inert document
 * （不执行脚本、不加载子资源），从不插入扩展页 DOM。
 */
const CSP =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
  `img-src data: blob:; style-src 'unsafe-inline'; font-src data:; ` +
  `base-uri 'none'; form-action 'none'">`;

/**
 * 改写 CSS 里的 url()。注意 base 必须是**这段 CSS 自身的 URL**：
 * 外链样式表里的相对路径是相对样式表解析的，不是相对页面。
 */
/**
 * 1x1 透明 GIF。资源没下载成功时用它占位，而不是把绝对 URL 留在 CSS 里：
 * 后者会让 srcdoc 里的每一条 url() 都去请求外网，被 CSP 拒绝后刷出成百上千条
 * 报错并拖慢预览（用户 debug#5 日志里几十条 font-src / img-src 违规即此）。
 */
const EMPTY_IMAGE_DATA_URL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export function rewriteCss(
  css: string,
  base: string,
  local: Map<string, string>,
): string {
  const body = css
    // @import 会在 CSP 下静默失败，直接去掉避免无意义请求
    .replace(/@import[^;]*;/gi, '')
    .replace(
      /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
      (full, _quote, raw: string) => {
        if (/^(data|blob|about):/i.test(raw)) return full;
        const abs = absoluteAssetUrl(raw, base);
        if (!abs) return full;
        const hit = local.get(abs);
        // base64 字符集不含引号/括号，无需加引号，避免序列化出 &quot;
        return hit ? `url(${hit})` : `url(${EMPTY_IMAGE_DATA_URL})`;
      },
    );

  // 字体没本地化就整块删掉：留着只会触发字体请求，浏览器最终仍回退到系统字体。
  // 已全部命中本地 data: 的 @font-face 保留，CSP 的 font-src data: 允许它生效。
  return body.replace(/@font-face\s*\{[^}]*\}/gi, (block) =>
    block.includes(EMPTY_IMAGE_DATA_URL) ? '' : block,
  );
}

function stripExternalCss(html: string): string {
  return html.replace(/<link\b[^>]*>/gi, (tag) =>
    (attrValue(tag, 'rel') ?? '').toLowerCase().includes('stylesheet')
      ? ''
      : tag,
  );
}

/**
 * 逐开标签复查，只删属性、不碰文本内容。
 *
 * 0.1.7 起这是**两道闸**：
 * 1) 在 `new DOMParser().parseFromString()` **之前**调用 —— 真实 Chrome 探针
 *    证实：扩展页 CSP（`script-src 'self' …`）下，解析带 on* 属性的原始快照
 *    本身就会为每个 inline handler 打一条 "Executing inline event handler
 *    violates …" 日志，DOMParser 文档是 inert 的也不例外。0.1.6 把清洗放在
 *    序列化之后，日志早在解析阶段就刷完了，所以用户控制台仍成片报错。
 * 2) 序列化之后再调用一次 —— 兜住 DOM 层实现差异（template.content、
 *    命名空间属性、畸形标签），保证最终 srcdoc 字符串也不含可执行属性。
 *
 * 正则用 (?:[^>"']|"[^"]*"|'[^']*')* 跳过引号内的 '>'，避免 title="a>b"
 * 之类的属性把标签提前截断；属性名用 \s* 起头，兼容 src="x"onerror="y"
 * 这种没有空格分隔的畸形写法。
 */
export function scrubSerializedAttributes(html: string): string {
  return html.replace(
    /<([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g,
    (_full, tag: string, attrs: string) => {
      const cleaned = attrs.replace(
        /\s*([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g,
        (attr: string, name: string, quoted?: string) => {
          const lower = name.toLowerCase();
          if (/^on/.test(lower) || lower === 'srcdoc') return '';
          const value = quoted
            ? /^["']/.test(quoted)
              ? quoted.slice(1, -1)
              : quoted
            : '';
          if (/^[\s\u0000-\u001f]*javascript:/i.test(value)) return '';
          return attr;
        },
      );
      return `<${tag}${cleaned}>`;
    },
  );
}

/** 把快照里的外链资源替换成本地 data: URL；未下载成功的保持空白，不假装离线 */
export function offlineHtml(
  html: string,
  base: string,
  local: Map<string, string>,
  extraCss = '',
): string {
  // 剔除脚本与外链 <link rel=stylesheet>（后者改由下面的本地 CSS 内联替代）
  const withoutLinks = stripExternalCss(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<script\b[^>]*\/?>/gi, ''),
  );

  // 关键：把「不可执行属性」从**待解析字符串**里先删掉，再交给 DOMParser。
  // 否则扩展页 CSP 会在 parseFromString 阶段逐条报 inline handler 违规，
  // 与 srcdoc 是否干净无关（0.1.7 / debug#4 的真实根因）。
  const safeHtml = scrubSerializedAttributes(withoutLinks);

  // 只解析、只改属性、立刻序列化；绝不 append 到扩展页 DOM
  const doc = new DOMParser().parseFromString(safeHtml, 'text/html');

  // debug#5：快照按不可信输入处理。原页面自带的 CSP / refresh 等 http-equiv
  // meta 必须全部移除——多条 CSP 会取交集，原页面的 script-src 'self' 会让
  // 内联事件报「unsafe-inline 缺失」；refresh 则让 sandbox iframe 反复尝试重定向。
  doc.querySelectorAll('meta[http-equiv]').forEach((el) => el.remove());

  // 所有能执行代码或加载外部内容的元素一律剔除。预览是静态快照，留着它们
  // 只会产生被 CSP 拒绝的请求和成片控制台报错。
  doc
    .querySelectorAll(
      'script,noscript,iframe,frame,frameset,object,embed,applet,base,link',
    )
    .forEach((el) => el.remove());

  // 内联事件属性与 javascript: URL：srcdoc 会**继承父文档的 CSP**（宿主网页
  // 或扩展页），每个残留的 on* 属性都会让浏览器打一条
  // "Executing inline event handler violates ... 'script-src 'self''" 日志，
  // 即使 sandbox="" 禁止脚本执行也会刷屏（debug#4 / 0.1.6）。
  function scrubAttributes(el: Element): void {
    const names: string[] =
      typeof el.getAttributeNames === 'function'
        ? el.getAttributeNames()
        : (Array.from(el.attributes ?? []) as { name: string }[]).map(
            (a) => a.name,
          );
    for (const name of names) {
      const lower = name.toLowerCase();
      const value = el.getAttribute(name) ?? '';
      if (/^on/.test(lower) || lower === 'srcdoc') {
        el.removeAttribute(name);
      } else if (/^\s*javascript:/i.test(value)) {
        el.removeAttribute(name);
      }
    }
  }

  // querySelectorAll('*') 不含 documentElement，也不进入 <template>.content
  // （那是一个独立的 DocumentFragment）。现代站点大量用 template 做懒加载，
  // 里面的 onerror 正是这次日志刷屏的漏口。
  const docEl = doc.documentElement;
  if (docEl) scrubAttributes(docEl);
  doc.querySelectorAll('*').forEach(scrubAttributes);
  doc.querySelectorAll('template').forEach((tpl) => {
    const content = (tpl as HTMLTemplateElement).content;
    if (!content) return;
    content.querySelectorAll?.('*').forEach(scrubAttributes);
    content.querySelectorAll?.('template').forEach((nested) => {
      nested.querySelectorAll?.('*').forEach(scrubAttributes);
    });
  });

  const lookup = (raw: string): string | undefined => {
    const abs = absoluteAssetUrl(raw, base);
    return abs ? local.get(abs) : undefined;
  };

  doc.querySelectorAll('img, source, video, input').forEach((el) => {
    // data: URL 本身含逗号，塞回 srcset 会被浏览器按候选分隔符切坏，
    // 所以命中后直接删掉 srcset、改用 src。
    const srcset = el.getAttribute('srcset');
    if (srcset) {
      const first = srcset.split(',')[0]?.trim().split(/\s+/)[0] ?? '';
      const hit = lookup(first);
      el.removeAttribute('srcset');
      if (hit) el.setAttribute('src', hit);
    }

    const src = el.getAttribute('src');
    if (src) {
      const hit = lookup(src);
      if (hit) el.setAttribute('src', hit);
      // 相对路径同样要判断：绝对化后是 http(s) 却没下载成功 → 移除，
      // 不留下会触发 CSP 报错的空请求；data:/blob: 则原样保留。
      else if (absoluteAssetUrl(src, base)) el.removeAttribute('src');
    }

    for (const attr of [
      'data-src',
      'data-original',
      'data-lazy-src',
      'poster',
    ]) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      const hit = lookup(value);
      if (hit) el.setAttribute(attr, hit);
      // 未下载成功就移除：data-* 留着已无意义（脚本全删了），而 <video poster>
      // 会被浏览器真的加载，留下绝对 URL 仍会触发 img-src 违规。
      else if (absoluteAssetUrl(value, base)) el.removeAttribute(attr);
    }
  });

  doc.querySelectorAll('[style]').forEach((el) => {
    el.setAttribute(
      'style',
      rewriteCss(el.getAttribute('style') ?? '', base, local),
    );
  });
  doc.querySelectorAll('style').forEach((el) => {
    el.textContent = rewriteCss(el.textContent ?? '', base, local);
  });

  // 外链样式表：原文已存本地，内联进 head；CSP 的 style-src 'unsafe-inline' 允许
  if (extraCss) {
    const style = doc.createElement('style');
    style.setAttribute('data-thoth', 'offline-css');
    // offlineHtml 是公共函数，不能假设调用方已经清洗过 CSS：这里再过一遍。
    // 已转成 data: 的 url() 会原样保留，所以重复调用是幂等的。
    style.textContent = rewriteCss(extraCss, base, local);
    const head = doc.querySelector('head');
    if (head) head.appendChild(style);
    else doc.documentElement.appendChild(style);
  }

  const head = doc.querySelector('head');
  if (head) head.insertAdjacentHTML('afterbegin', CSP);
  else doc.documentElement.insertAdjacentHTML('afterbegin', CSP);

  return scrubSerializedAttributes(
    '<!doctype html>\n' + doc.documentElement.outerHTML,
  );
}

/** 单条预览最多内联的原始字节。base64 会再膨胀约 1/3，防止 srcdoc 撑到卡顿 */
const MAX_INLINE_BYTES = 12 * 1024 * 1024;
/** 内联 CSS 总量上限（外链样式表可能很多，避免把 srcdoc 撑爆） */
const MAX_CSS_BYTES = 2 * 1024 * 1024;

// 预览缓存：每次生成都要 bulkGet + 把 Blob 转 base64。后台每落地一张资源都会
// 广播 ASSETS_CHANGED，同一条目来回悬停也会重复这笔开销。资源按原始 URL 全局
// 去重、下载后不再变化，缓存是安全的；清空离线资源或有新资源落地时统一失效。
const dataUrlCache = new Map<string, string>();
const htmlCache = new Map<string, string>();
let dataUrlCacheBytes = 0;
const MAX_DATA_URL_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_HTML_CACHE_ENTRIES = 24;

/** 离线资源发生变化时调用；避免预览拿到过期的 srcdoc */
export function invalidateOfflineCache(): void {
  dataUrlCache.clear();
  htmlCache.clear();
  dataUrlCacheBytes = 0;
}

/** 只读这条预览真正用到的资源，避免把整库 Blob 都转成 base64 */
export async function offlineHtmlFor(
  capture: { html: string; url: string },
  cacheKey?: string,
): Promise<string> {
  if (cacheKey) {
    const hit = htmlCache.get(cacheKey);
    if (hit) return hit;
  }

  const res = extractResourceUrls(capture.html, capture.url);
  const primary = [
    ...res.images,
    ...res.styles,
    ...res.scripts,
    ...res.fonts,
  ];
  const primaryRows = primary.length
    ? await db.assets.bulkGet(primary)
    : [];

  // 样式表里可能再引用图片/字体，按样式表 URL 解析后一并取出
  const cssSources: { url: string; text: string }[] = [];
  const extraUrls: string[] = [];
  for (const a of primaryRows) {
    if (a?.kind !== 'style' || a.status !== 'saved' || !a.text) continue;
    cssSources.push({ url: a.url, text: a.text });
    const refs = extractCssUrls(a.text, a.url);
    extraUrls.push(...refs.images, ...refs.fonts);
  }

  const allUrls = [...new Set([...primary, ...extraUrls])];
  const rows = allUrls.length ? await db.assets.bulkGet(allUrls) : [];
  const local = new Map<string, string>();
  let inlineBytes = 0;
  for (const a of rows) {
    if (a?.status !== 'saved' || !a.blob) continue;
    if (inlineBytes + a.size > MAX_INLINE_BYTES) continue;
    try {
      let dataUrl = dataUrlCache.get(a.url);
      if (!dataUrl) {
        dataUrl = await blobToDataUrl(a.blob);
        dataUrlCache.set(a.url, dataUrl);
        dataUrlCacheBytes += a.size;
        if (dataUrlCacheBytes > MAX_DATA_URL_CACHE_BYTES) {
          // 不精确淘汰，直接清空重来：内存有上界即可
          dataUrlCache.clear();
          dataUrlCacheBytes = 0;
        }
      }
      local.set(a.url, dataUrl);
      inlineBytes += a.size;
    } catch {
      // 单张转换失败不影响其余资源，也不影响快照本身可读
    }
  }

  let cssBytes = 0;
  const parts: string[] = [];
  for (const src of cssSources) {
    if (cssBytes + src.text.length > MAX_CSS_BYTES) break;
    cssBytes += src.text.length;
    parts.push(rewriteCss(src.text, src.url, local));
  }

  const result = offlineHtml(
    capture.html,
    capture.url,
    local,
    parts.join('\n'),
  );
  if (cacheKey) {
    htmlCache.set(cacheKey, result);
    if (htmlCache.size > MAX_HTML_CACHE_ENTRIES) {
      const oldest = htmlCache.keys().next().value;
      if (oldest) htmlCache.delete(oldest);
    }
  }
  return result;
}
