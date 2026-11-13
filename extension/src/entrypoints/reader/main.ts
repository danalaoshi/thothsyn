import { ext } from '../../lib/webext';
import './reader.css';
import { db } from '../../db/database';
import { offlineHtmlFor } from '../../lib/offline';
import { applyI18n, t } from '../../lib/i18n';

// 从收藏库点开条目时读的是「本地保存的快照」，不跳原网页。
// 快照始终按不可信输入处理：只进 sandbox iframe（不开放 scripts / same-origin）。
async function init() {
  applyI18n(document); // 页面标题、按钮与 iframe 的 title 跟随浏览器语言
  const id = new URLSearchParams(location.search).get('id') ?? '';
  const cap = id ? await db.captures.get(id) : undefined;
  const titleEl = document.querySelector<HTMLElement>('#title')!;
  const frame = document.querySelector<HTMLIFrameElement>('#view')!;
  const originBtn =
    document.querySelector<HTMLButtonElement>('#open-origin')!;

  if (!cap) {
    titleEl.textContent = t('未找到这条收藏');
    originBtn.disabled = true;
    return;
  }

  document.title = cap.title;
  titleEl.textContent = cap.title;
  // 与收藏库预览一致：读本地快照 + 内联已下载的离线图片，全程不联网
  frame.srcdoc = await offlineHtmlFor({
    html:
      cap.html ||
      `<body style="padding:24px;font:16px/1.7 system-ui,sans-serif">${esc(cap.text)}</body>`,
    url: cap.url,
  });

  if (cap.url) {
    originBtn.addEventListener('click', () => {
      void ext.tabs.create({ url: cap.url });
    });
  } else {
    originBtn.disabled = true;
  }
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
}

void init();
