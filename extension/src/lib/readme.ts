import { db } from '../db/database';
import { README_MARKDOWN } from './readme-content';
import { defaultBusinessFolder, ensureSeed } from './seed';
import { addCapture, patchCapture } from './repo';
import { bumpRevision } from './settings';
import type { Capture } from '../types';

/**
 * debug#2：安装 / 升级后，业务文件夹下始终有一条名为 readme 的收藏。
 * 内容就是 docs/readme.md（编译期常量），将来换成正式使用说明只改那份文件。
 *
 * 这条是普通的 Capture，所以能被搜索、悬停预览、拖拽分类；它没有原网页，
 * 点击时由收藏库打开本地 reader.html 读快照。
 */
export const README_ID = 'thoth-readme';
export const README_TITLE = 'readme';

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
}

/** 先转义再放行极少量行内标记；不解析链接，避免把外链带进离线快照 */
function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/** 极简 Markdown → 完整 HTML 页面。输入按不可信文本处理，只产出静态标签。 */
export function readmeSourceToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  for (const line of lines) {
    const text = line.trim();
    if (!text) {
      closeList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(text);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length + 1, 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const item = /^[-*+]\s+(.*)$/.exec(text);
    if (item) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(item[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(text)}</p>`);
  }
  closeList();

  const style = [
    'body{margin:0;background:#fff;color:#1c2024;font:15px/1.75 system-ui,sans-serif}',
    'article{max-width:760px;margin:0 auto;padding:32px 28px 64px}',
    'h1{font-size:28px;margin:.4em 0 .2em}h2{font-size:21px;margin:1.6em 0 .5em}',
    'h3{font-size:17px;margin:1.3em 0 .4em}p{margin:.55em 0}',
    'ul{padding-left:22px}li{margin:.3em 0}',
    'code{background:#f2f4f7;border-radius:4px;padding:1px 5px;font-size:.9em}',
    'strong{font-weight:600}',
  ].join('');

  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<style>${style}</style></head><body><article>${out.join('\n')}` +
    '</article></body></html>'
  );
}

export function readmeHtml(): string {
  return readmeSourceToHtml(README_MARKDOWN);
}

/**
 * 幂等 upsert。升级时只同步正文（将来换成使用说明能生效），
 * 用户改过的标题、归属文件夹、标签一律保留；收藏被删则下次安装/升级补回。
 * 返回是否真的写了库，只有写库才 bump 数据版本号。
 */
let pending: Promise<boolean> | undefined;

/** 同一个 Service Worker 生命周期内去重：顶层启动与 onInstalled 可能同时触发 */
export function ensureReadmeCapture(): Promise<boolean> {
  if (!pending) {
    pending = doEnsureReadmeCapture().catch((e) => {
      pending = undefined;
      throw e;
    });
  }
  return pending;
}

async function doEnsureReadmeCapture(): Promise<boolean> {
  await ensureSeed();
  const html = readmeHtml();
  const existing = await db.captures.get(README_ID);
  if (existing) {
    if (existing.html === html && existing.text === README_MARKDOWN) return false;
    await patchCapture(README_ID, {
      html,
      text: README_MARKDOWN,
    });
    await bumpRevision();
    return true;
  }

  const folder = await defaultBusinessFolder();
  await addCapture({
    id: README_ID,
    title: README_TITLE,
    // 没有原网页：收藏库点击时会改成打开本地 reader.html
    url: '',
    html,
    text: README_MARKDOWN,
    kind: 'full',
    folderId: folder?.id ?? null,
    tags: [],
    createdAt: Date.now(),
  });
  await bumpRevision();
  return true;
}
