import { db } from '../db/database';
import type { Asset, AssetKind } from '../types';

/**
 * 离线资源（v0.1.3 起，v0.1.4 扩展到 CSS / 字体 / 脚本存档）。
 *
 * 设计要点：
 * - 按「原始绝对 URL」全局去重：多条收藏引用同一份资源只存一份。
 * - 采集阶段只收集 URL，不做任何体积估算拦截；体积限制只在下载完成后
 *   按 `blob.size` / 文本真实字节数生效（沿用 doc/实施交接.md 的规则）。
 * - 队列落库（status=pending），MV3 Service Worker 随时可能被终止，
 *   下次唤醒从 pending 续跑，不会丢任务。
 * - 失败必须留状态 + failureReason，不假装已经离线保存。
 * - **脚本只存档，绝不注入预览**：快照始终在 sandbox="" iframe 里渲染，
 *   这是项目不可偏离的安全规则。存下来是为了将来可做「原站资源审计」。
 */

/** 单张图片上限（真实字节），保留旧导出名以兼容设置页 */
export const MAX_ASSET_BYTES = 4 * 1024 * 1024;
/** 本地离线资源总量软上限；超过后新任务进入 awaiting_permission */
export const MAX_TOTAL_BYTES = 300 * 1024 * 1024;
/** 单条收藏最多收集多少个候选 URL（只防病态页面，不是体积拦截） */
export const MAX_ASSETS_PER_CAPTURE = 80;
const MAX_STYLES_PER_CAPTURE = 24;
const MAX_SCRIPTS_PER_CAPTURE = 24;
/** 内联 CSS 里的字体数量上限，避免一个页面把下载队列塞满 */
const MAX_FONTS_PER_CAPTURE = 24;
/** 字体扩展名（带查询参数也算），用于把字体从「图片候选」里分流出去 */
const FONT_URL_RE = /\.(woff2?|ttf|otf|eot)(\?|#|$)/i;

/** 各类资源的单文件上限（真实字节） */
const MAX_KIND_BYTES: Record<AssetKind, number> = {
  image: MAX_ASSET_BYTES,
  style: 1024 * 1024,
  script: 2 * 1024 * 1024,
  font: 2 * 1024 * 1024,
};

const CONCURRENCY = 3;
const TIMEOUT_MS = 12_000;

/**
 * 快照里图片 URL 可能出现的位置：
 * `<img src>` / `<source srcset>` / 懒加载 `data-*` / `poster` / CSS `url(...)`。
 * 供「后台提取待下载清单」与「预览内联替换」共用，避免两边规则漂移。
 */
export const ASSET_URL_RE =
  /(\b(?:src|srcset|data-src|data-srcset|data-original|data-lazy-src|poster)\s*=\s*["'])([^"']+)(["'])|(url\(\s*["']?)([^"')]+)(["']?\s*\))/gi;

/** script/iframe/video 等块里的 src 不是图片，先剥掉减少无意义请求 */
const NON_IMAGE_BLOCK_RE =
  /<(script|iframe|video|audio|noscript|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** 相对路径按收藏来源页绝对化；只接受 http(s)，其余一律忽略 */
export function absoluteAssetUrl(raw: string, base: string): string | null {
  const s = raw.trim().replace(/&amp;/g, '&');
  if (!s || /^(data|blob|about|chrome-extension|javascript):/i.test(s)) {
    return null;
  }
  try {
    const u = new URL(s, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** srcset 形如 "a.jpg 1x, b.jpg 2x"，按逗号拆后取每段第一个 token */
function candidates(raw: string): string[] {
  if (!raw.includes(',')) return [raw.trim()];
  return raw
    .split(',')
    .map((p) => p.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean);
}

/** 从快照 HTML 里抽取待下载的绝对图片 URL（不联网、不判断体积） */
export function extractImageUrls(html: string, base: string): string[] {
  const cleaned = html.replace(NON_IMAGE_BLOCK_RE, '');
  const out = new Set<string>();
  const add = (raw: string): boolean => {
    // 字体由 extractFontUrls() 按 font 类别单独入队。以前把它当图片入队，
    // 下载时 content-type 不符会全部标 failed，字体也就永远无法离线显示。
    if (FONT_URL_RE.test(raw.trim())) return false;
    const abs = absoluteAssetUrl(raw, base);
    if (!abs) return false;
    out.add(abs);
    return out.size >= MAX_ASSETS_PER_CAPTURE;
  };

  ASSET_URL_RE.lastIndex = 0;
  for (const m of cleaned.matchAll(ASSET_URL_RE)) {
    const attrPart = m[1] ?? '';
    const attrValue = m[2];
    const cssValue = m[5];

    if (attrValue !== undefined) {
      // 只有 srcset 才有「URL 描述符, URL 描述符」语法。普通属性里的逗号
      // 属于 URL 本身（如 data:image/png;base64,xxx），切开会产生伪造 URL。
      const isSrcset = /\b(?:data-)?srcset\s*=/i.test(attrPart);
      const list = isSrcset ? candidates(attrValue) : [attrValue.trim()];
      for (const c of list) if (add(c)) return [...out];
    } else if (cssValue !== undefined) {
      if (add(cssValue)) return [...out];
    }
  }
  return [...out];
}

/**
 * 调试反馈 #4：把外链样式表与脚本也纳入下载清单。
 * 用正则而非 DOMParser —— 本模块跑在 Service Worker，那里没有 DOM。
 */
export interface SnapshotResources {
  images: string[];
  styles: string[];
  scripts: string[];
  /** 内联 <style> / style 属性里引用的字体，按 font 类别入队 */
  fonts: string[];
}

export function attrValue(tag: string, name: string): string | null {
  const m = new RegExp(
    `\\b${name}\\s*=\\s*(?:["']([^"']+)["']|([^\\s>]+))`,
    'i',
  ).exec(tag);
  return m?.[1] ?? m?.[2] ?? null;
}

/**
 * 内联 <style> 与 style 属性里的字体 URL。外链样式表的字体在 CSS 下载完成后
 * 由 extractCssUrls() 继续入队；这里只补「页面内联 CSS」这一块。
 * 按字体类别入队，才能用正确的 content-type 校验存成本地 Blob。
 */
export function extractFontUrls(html: string, base: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    const raw = m[1] ?? '';
    if (!FONT_URL_RE.test(raw.trim())) continue;
    const abs = absoluteAssetUrl(raw, base);
    if (abs) out.add(abs);
    if (out.size >= MAX_FONTS_PER_CAPTURE) break;
  }
  return [...out];
}

export function extractResourceUrls(html: string, base: string): SnapshotResources {
  const images = extractImageUrls(html, base);
  const styles = new Set<string>();
  const scripts = new Set<string>();

  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = (attrValue(tag, 'rel') ?? '').toLowerCase();
    if (!rel.includes('stylesheet')) continue;
    const href = attrValue(tag, 'href');
    const abs = href ? absoluteAssetUrl(href, base) : null;
    if (abs) styles.add(abs);
    if (styles.size >= MAX_STYLES_PER_CAPTURE) break;
  }

  for (const m of html.matchAll(
    /<script\b[^>]*\bsrc\s*=\s*(?:["']([^"']+)["'])([^>]*)>/gi,
  )) {
    const abs = absoluteAssetUrl(m[1], base);
    if (abs) scripts.add(abs);
    if (scripts.size >= MAX_SCRIPTS_PER_CAPTURE) break;
  }

  return {
    images,
    styles: [...styles],
    scripts: [...scripts],
    fonts: extractFontUrls(html, base),
  };
}

/** CSS 里的 url() 相对于**样式表自身 URL**解析，不是相对于页面 URL */
export function extractCssUrls(
  css: string,
  cssUrl: string,
): { images: string[]; fonts: string[] } {
  const images = new Set<string>();
  const fonts = new Set<string>();
  // @import 的 url() 指向的是另一份样式表，不是图片；
  // 内联时会剔除 @import，这里也别把它当图片入队，否则会留下无意义的 failed 记录。
  const body = css.replace(/@import[^;]*;/gi, '');
  for (const m of body.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)) {
    const raw = m[2];
    if (/^(data|blob|about):/i.test(raw)) continue;
    const abs = absoluteAssetUrl(raw, cssUrl);
    if (!abs) continue;
    if (/\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(abs)) fonts.add(abs);
    else images.add(abs);
  }
  return { images: [...images], fonts: [...fonts] };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// 队列
// ---------------------------------------------------------------------------

/** 把候选 URL 写成 pending；已 saved / failed / awaiting 的不重复入队 */
export async function enqueueAssets(
  urls: string[],
  kind: AssetKind = 'image',
): Promise<void> {
  if (!urls.length) return;
  const existing = await db.assets.bulkGet(urls);
  const known = new Map<string, Asset>();
  for (const a of existing) if (a) known.set(a.url, a);

  const rows: Asset[] = [];
  for (const url of urls) {
    const cur = known.get(url);
    if (cur && cur.status !== 'pending') continue;
    rows.push({
      url,
      kind,
      mime: '',
      size: 0,
      status: 'pending',
      createdAt: Date.now(),
    });
  }
  if (rows.length) await db.assets.bulkPut(rows);
}

/** 总量只在队列启动时统计一次，之后增量维护，避免反复读 Blob */
let cachedBytes = -1;

export async function savedBytes(): Promise<number> {
  if (cachedBytes < 0) {
    const saved = await db.assets.where('status').equals('saved').toArray();
    cachedBytes = saved.reduce((n, a) => n + (a.size || 0), 0);
  }
  return cachedBytes;
}

export function resetBytesCache(): void {
  cachedBytes = -1;
}

export interface AssetStats {
  count: number;
  bytes: number;
  failed: number;
  pending: number;
  awaiting: number;
  images: number;
  styles: number;
  scripts: number;
  fonts: number;
}

export async function assetStats(): Promise<AssetStats> {
  const all = await db.assets.toArray();
  const stats: AssetStats = {
    count: 0,
    bytes: 0,
    failed: 0,
    pending: 0,
    awaiting: 0,
    images: 0,
    styles: 0,
    scripts: 0,
    fonts: 0,
  };
  for (const a of all) {
    if (a.status === 'saved') {
      stats.count += 1;
      stats.bytes += a.size || 0;
      const kind = a.kind ?? 'image';
      if (kind === 'image') stats.images += 1;
      else if (kind === 'style') stats.styles += 1;
      else if (kind === 'script') stats.scripts += 1;
      else if (kind === 'font') stats.fonts += 1;
    } else if (a.status === 'failed') stats.failed += 1;
    else if (a.status === 'pending') stats.pending += 1;
    else if (a.status === 'awaiting_permission') stats.awaiting += 1;
  }
  cachedBytes = stats.bytes;
  return stats;
}

/** Blob → data: URL。分块编码，避免大图一次展开爆栈；Service Worker 也可调用 */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

function mimeMatches(kind: AssetKind, mime: string, url: string): boolean {
  switch (kind) {
    case 'image':
      return mime.startsWith('image/');
    case 'style':
      return (
        /css/i.test(mime) ||
        /^text\/plain/i.test(mime) ||
        /\.(css|less|scss)(\?|#|$)/i.test(url)
      );
    case 'script':
      return (
        /javascript|ecmascript/i.test(mime) ||
        /^text\/plain/i.test(mime) ||
        /\.m?js(\?|#|$)/i.test(url)
      );
    case 'font':
      return (
        /font|woff|ttf|otf/i.test(mime) ||
        /\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(url) ||
        mime === 'application/octet-stream'
      );
  }
}

async function downloadOne(row: Asset, onSaved: (url: string) => void): Promise<void> {
  const { url } = row;
  const kind: AssetKind = row.kind ?? 'image'; // 0.1.3 老记录没有 kind，一律当图片
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    if ((await savedBytes()) >= MAX_TOTAL_BYTES) {
      await db.assets.put({
        ...row,
        mime: '',
        size: 0,
        status: 'awaiting_permission',
        failureReason: `本地离线资源已达 ${formatBytes(MAX_TOTAL_BYTES)} 软上限，请在设置页清理后重试`,
        createdAt: Date.now(),
      });
      return;
    }

    // host_permissions 已含 <all_urls>，Service Worker 的跨域 fetch 免除 CORS。
    // credentials:'omit' 不携带任何站点 Cookie，避免把登录态发给第三方图床。
    const res = await fetch(url, { signal: ctl.signal, credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const mime = (res.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!mimeMatches(kind, mime, url)) {
      throw new Error(`资源类型不符（content-type: ${mime || '未知'}）`);
    }

    const isText = kind === 'style' || kind === 'script';
    const blob = isText ? null : await res.blob();
    const text = isText ? await res.text() : '';
    if (isText) {
      const head = text.trimStart().slice(0, 100).toLowerCase();
      // 有些站点 404 会回 HTML 但状态码 200，别把错误页当成样式表存下来
      if (
        head.startsWith('<!doctype') ||
        head.startsWith('<html') ||
        head.startsWith('<?xml')
      ) {
        throw new Error('响应不是样式/脚本（疑似 HTML 错误页）');
      }
    }
    const size = blob ? blob.size : new Blob([text]).size;
    if (size > MAX_KIND_BYTES[kind]) {
      throw new Error(`超过单文件上限 ${formatBytes(MAX_KIND_BYTES[kind])}`);
    }
    if (size === 0) throw new Error('空文件');

    await db.assets.put({
      url,
      kind,
      mime,
      ...(blob ? { blob } : { text }),
      size,
      status: 'saved',
      createdAt: Date.now(),
    });
    cachedBytes += size;
    onSaved(url);

    // 样式表里引用的图片/字体要按**样式表 URL**解析后再入队，
    // 这样预览内联 CSS 时才能把 url() 换成本地 data: URL。
    if (kind === 'style') {
      const refs = extractCssUrls(text, url);
      await Promise.all([
        enqueueAssets(refs.images, 'image'),
        enqueueAssets(refs.fonts, 'font'),
      ]);
    }
  } catch (err) {
    await db.assets.put({
      url,
      kind,
      mime: '',
      size: 0,
      status: 'failed',
      failureReason: err instanceof Error ? err.message : String(err),
      createdAt: Date.now(),
    });
  } finally {
    clearTimeout(timer);
  }
}

let running = false;

/**
 * 跑完所有 pending；worker 被杀后残留的 pending 会在下次唤醒继续。
 * 每轮结束再查一次 pending：样式表内新发现的资源能立刻被同一轮捡到。
 */
export async function runAssetQueue(
  onSaved: (url: string) => void,
): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (let round = 0; round < 20; round += 1) {
      const pending = await db.assets.where('status').equals('pending').toArray();
      if (!pending.length) break;

      let i = 0;
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, pending.length) }, async () => {
          while (i < pending.length) {
            const row = pending[i++];
            await downloadOne(row, onSaved);
          }
        }),
      );
    }
  } finally {
    running = false;
  }
}
