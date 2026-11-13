import { ext, openTab } from '../../lib/webext';
import './library.css';
import { db } from '../../db/database';
import type { Capture, Folder } from '../../types';
import {
  DEFAULT_FOLDER_NAME,
  listBusinessFolders,
  listTagFolders,
} from '../../lib/seed';
import { invalidateOfflineCache, offlineHtmlFor } from '../../lib/offline';
import { patchCapture, removeCapture as removeCaptureRecord } from '../../lib/repo';
import { README_ID } from '../../lib/readme';
import { applyI18n, folderLabel, t } from '../../lib/i18n';
import {
  bumpRevision,
  DELETE_CONFIRM_KEY,
  getBool,
  needsDeleteConfirm,
  REVISION_KEY,
} from '../../lib/settings';
import type {
  ThothPreviewShowMsg,
  ThothPreviewHideMsg,
} from '../../lib/messages';

type Filter =
  | { kind: 'all' }
  | { kind: 'business'; id: string }
  | { kind: 'tag'; id: string };

interface State {
  filter: Filter;
  activeTags: Set<string>;
  query: string;
  business: Folder[];
  tags: Folder[];
}

const state: State = {
  filter: { kind: 'all' },
  activeTags: new Set<string>(),
  query: '',
  business: [],
  tags: [],
};

const counts = {
  all: 0,
  biz: new Map<string, number>(),
  tag: new Map<string, number>(),
  /** folderId 为 null 的收藏（历史数据 / 业务文件夹被删后），归在「未分类」里显示 */
  unassigned: 0,
};

const app = document.querySelector<HTMLDivElement>('#app')!;

/**
 * debug#1：chrome:// 等页面无法注入 content script，background 会兜底打开
 * library.html 作为独立标签页。此时自己是顶层窗口，就把 #app 收敛成 360px
 * 左栏（右侧留中性画布），而不是让收藏库铺满整个页面。
 */
const standalone = window.top === window.self;
if (standalone) document.body.classList.add('standalone');

// 独立标签页里没有父页面 content script 来画预览浮层，这里自己接一次。
// window.parent === window，所以 postMessage 会回到本窗口；校验 source 即可。
const standalonePreview =
  document.querySelector<HTMLElement>('#standalone-preview');
if (standalone && standalonePreview) {
  const spFrame = standalonePreview.querySelector('iframe');
  const spTitle = standalonePreview.querySelector<HTMLElement>('.sp-title');
  const spClose = standalonePreview.querySelector('.sp-close');
  const spHide = (e?: Event) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    standalonePreview.hidden = true;
  };
  spClose?.addEventListener('pointerdown', spHide);
  spClose?.addEventListener('click', spHide);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') standalonePreview.hidden = true;
  });
  window.addEventListener('message', (e) => {
    // 顶层窗口时 parent === self；两种写法都收下，避免不同 Chrome 版本
    // 把 self-postMessage 的 source / origin 暴露得不一致（file:// 下 origin 为 null）。
    if (e.source !== window && e.source !== window.parent) return;
    const d = e.data as
      | ({ type?: string; source?: string; html?: string; title?: string })
      | undefined;
    if (!d || d.source !== 'thothsyn-library') return;
    if (d.type === 'THOTH_PREVIEW_HIDE') {
      standalonePreview.hidden = true;
      return;
    }
    if (d.type !== 'THOTH_PREVIEW_SHOW') return;
    standalonePreview.hidden = false;
    if (spTitle) spTitle.textContent = d.title ?? '';
    if (d.html && spFrame) spFrame.srcdoc = d.html;
  });
}

let listEl: HTMLElement | null = null;
let dragging = false;
let searchTimer = 0;
/** 与父页面 content.ts 的 pvCurrentId 对齐：同一条目只传一次 HTML */
let lastPreviewId = '';
/** 后台又下载完资源时置脏：下次悬停重新内联一次，之后继续复用 */
let previewDirty = false;
/** 删除是否需要二次确认；设置页改开关后通过 storage.onChanged 即时生效 */
let deleteConfirm = false;

// ---------------- 数据加载与计数 ----------------
async function loadData(): Promise<void> {
  state.business = await listBusinessFolders();
  state.tags = await listTagFolders();
  const caps = await db.captures.toArray();
  counts.all = caps.length;
  counts.biz = new Map();
  counts.tag = new Map();
  counts.unassigned = 0;
  for (const c of caps) {
    if (c.folderId)
      counts.biz.set(c.folderId, (counts.biz.get(c.folderId) ?? 0) + 1);
    else counts.unassigned += 1;
    for (const t of c.tags)
      counts.tag.set(t, (counts.tag.get(t) ?? 0) + 1);
  }
}

// ---------------- 渲染 ----------------
function render(): void {
  dragging = false;
  lastPreviewId = '';
  app.innerHTML = '';

  const tree = document.createElement('aside');
  tree.className = 'tree';

  const scroll = document.createElement('div');
  scroll.className = 'tree-scroll';
  scroll.appendChild(renderTree());
  tree.appendChild(scroll);

  // debug#5：模仿 Codex 桌面版，设置入口放在左侧栏最底部
  const foot = document.createElement('div');
  foot.className = 'tree-foot';
  foot.innerHTML = `
    <button class="settings-entry" type="button" title="打开设置（管理文件夹、导入、偏好）" aria-label="打开设置">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3.2" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.5 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.14.36.4.66.73.86.3.18.65.28 1 .28H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z" />
      </svg>
      <span class="settings-label">设置</span>
      <span class="settings-ver">v${esc(ext.runtime.getManifest().version)}</span>
    </button>`;
  foot.querySelector('button')?.addEventListener('click', () => {
    // 在 Firefox 被注入到普通网页的 library iframe 里 ext.tabs 为 undefined，
    // 直接用 openTab()：有 tabs 就直连，没有就交给后台代开（见 webext.ts）。
    void openTab(ext.runtime.getURL('options.html')).catch((e) =>
      console.error('[thoth] open settings failed', e),
    );
  });
  tree.appendChild(foot);
  mountTreeSplitter(tree);

  const main = document.createElement('section');
  main.className = 'main';
  main.appendChild(renderTopbar());
  main.appendChild(renderTagSearch());
  const list = document.createElement('div');
  list.className = 'list';
  listEl = list;
  main.appendChild(list);

  app.append(tree, main);
  wireTree(tree);
  applyI18n(app);
  void hydrateList(list);
}

function renderTree(): DocumentFragment {
  const frag = document.createDocumentFragment();

  const all = document.createElement('div');
  all.className = 'node all' + (state.filter.kind === 'all' ? ' active' : '');
  all.dataset.filter = 'all';
  all.innerHTML = `<span>全部收藏</span><span class="count">${counts.all}</span>`;
  frag.appendChild(all);

  const hb = document.createElement('h3');
  hb.textContent = '业务文件夹';
  frag.appendChild(hb);
  for (const f of state.business) {
    const n = document.createElement('div');
    n.className =
      'node business' +
      (state.filter.kind === 'business' && state.filter.id === f.id
        ? ' active'
        : '');
    n.dataset.biz = f.id;
    // 「未分类」是默认分类：folderId 为空的历史收藏也算在这里面
    const n0 =
      (counts.biz.get(f.id) ?? 0) +
      (f.name === DEFAULT_FOLDER_NAME ? counts.unassigned : 0);
    n.innerHTML = `<span class="dot"></span><span data-no-i18n>${esc(folderLabel(f.name))}</span><span class="count">${n0}</span>`;
    frag.appendChild(n);
  }

  const ht = document.createElement('h3');
  ht.textContent = '标签文件夹';
  frag.appendChild(ht);
  for (const f of state.tags) {
    const n = document.createElement('div');
    n.className =
      'node tag' +
      (state.filter.kind === 'tag' && state.filter.id === f.id ? ' active' : '');
    n.dataset.tag = f.id;
    n.innerHTML = `<span class="dot"></span><span data-no-i18n>${esc(folderLabel(f.name))}</span><span class="count">${counts.tag.get(f.id) ?? 0}</span>`;
    frag.appendChild(n);
  }
  frag.querySelectorAll('.node').forEach((n) => {
    n.setAttribute('tabindex', '0');
    n.setAttribute('role', 'button');
  });
  return frag;
}

/** debug#5：导入搬进设置页、设置入口搬进左侧栏底部，顶栏只留标题与搜索 */
function renderTopbar(): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'topbar';

  const title = document.createElement('div');
  title.className = 'title';
  // filterTitle() 已经自己取过译文/文件夹名，标 data-no-i18n 防止二次处理
  title.setAttribute('data-no-i18n', '');
  title.textContent = filterTitle();
  title.title = filterTitle();

  const searchWrap = document.createElement('div');
  searchWrap.className = 'search-wrap';
  searchWrap.setAttribute('role', 'search');
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'search';
  search.placeholder = '搜索收藏';
  search.setAttribute('aria-label', '搜索收藏：标题、网址或正文');
  search.value = state.query;
  search.addEventListener('input', () => {
    state.query = search.value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      if (listEl) void hydrateList(listEl);
    }, 120);
  });
  const kbd = document.createElement('kbd');
  kbd.className = 'kbd';
  kbd.textContent = '/';
  kbd.setAttribute('aria-hidden', 'true');
  searchWrap.append(search, kbd);

  bar.append(title, searchWrap);
  return bar;
}

function renderTagSearch(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'tagsearch';
  if (state.tags.length === 0) {
    wrap.innerHTML = `<span class="tagsearch-empty">暂无标签文件夹（在「设置」中新建）</span>`;
    return wrap;
  }
  for (const f of state.tags) {
    const c = document.createElement('span');
    c.className = 'chip' + (state.activeTags.has(f.id) ? ' on' : '');
    c.setAttribute('data-no-i18n', '');
    c.textContent = folderLabel(f.name);
    c.addEventListener('click', () => {
      if (state.activeTags.has(f.id)) state.activeTags.delete(f.id);
      else state.activeTags.add(f.id);
      render();
    });
    wrap.appendChild(c);
  }
  wrap.querySelectorAll('.chip').forEach((c) => {
    c.setAttribute('tabindex', '0');
    c.setAttribute('role', 'button');
  });
  wrap.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const chip = (e.target as HTMLElement).closest('.chip') as HTMLElement | null;
    if (!chip) return;
    e.preventDefault();
    chip.click();
  });
  return wrap;
}

async function hydrateList(list: HTMLElement): Promise<void> {
  const items = await getFiltered();
  if (items.length === 0) {
    list.innerHTML = state.query.trim()
      ? `<div class="empty"><b>没有匹配的收藏</b><br/>换个关键词，或清空搜索框。</div>`
      : `<div class="empty">这里还没有收藏。<br/>点击工具栏图标保存整页，或右键选择「部分保存」。</div>`;
    applyI18n(list);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const cap of items) frag.appendChild(renderItem(cap));
  list.replaceChildren(frag);
  applyI18n(list);
}

/** 预览内容一律来自本地 Dexie 快照；部分保存就是选中的 DOM */
function previewHtmlOf(cap: Capture): string {
  return (
    cap.html ||
    `<body style="padding:16px;font:15px/1.7 system-ui,sans-serif">${esc(cap.text)}</body>`
  );
}

function renderItem(cap: Capture): HTMLElement {
  const el = document.createElement('div');
  // debug#3：readme 是内置说明页，视觉上要一眼区别于普通收藏
  el.className = 'item' + (cap.id === README_ID ? ' readme' : '');
  el.draggable = true;
  el.dataset.id = cap.id;
  const tags = cap.tags
    .map((id) => state.tags.find((t) => t.id === id)?.name)
    .filter(Boolean);
  const biz = state.business.find((b) => b.id === cap.folderId)?.name;
  el.innerHTML = `
    <div class="it-row">
      <span class="drag" title="拖到左侧文件夹分类">⋮⋮</span>
      <div class="it-body">
        <div class="it-title" data-no-i18n>${esc(cap.title)}</div>
        <div class="it-meta">
          ${cap.id === README_ID ? '<span class="badge readme" data-no-i18n>README</span>' : ''}
          ${cap.kind === 'partial' ? '<span class="badge tag">片段</span>' : ''}
          ${biz ? `<span class="badge biz" data-no-i18n>${esc(folderLabel(biz))}</span>` : ''}
          ${tags.map((tag) => `<span class="badge tag" data-no-i18n>${esc(folderLabel(tag!))}</span>`).join('')}
        </div>
      </div>
      <button class="it-del" type="button" title="删除这条收藏" aria-label="${esc(t('删除收藏 $1', cap.title))}">×</button>
    </div>`;

  el.addEventListener('mouseenter', (e) => {
    if (dragging) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const same = lastPreviewId === cap.id && !previewDirty;
    lastPreviewId = cap.id;

    const send = (html: string) => {
      if (lastPreviewId !== cap.id) return;
      previewDirty = false;
      const msg: ThothPreviewShowMsg = {
        source: 'thothsyn-library',
        type: 'THOTH_PREVIEW_SHOW',
        id: cap.id,
        title: cap.title,
        html,
        y: rect.top,
      };
      window.parent.postMessage(msg, '*');
    };

    if (same) {
      send('');
      return;
    }
    void offlineHtmlFor({ html: previewHtmlOf(cap), url: cap.url }, cap.id)
      .then(send)
      .catch(() =>
        send(
          `<!doctype html><meta charset="utf-8"><body style="padding:20px;font:14px/1.6 system-ui;color:#626a74">${t('本地预览生成失败，请重新悬停一次。')}</body>`,
        ),
      );
  });
  el.addEventListener('mouseleave', hidePreview);
  el.addEventListener('click', (e) => {
    // 删除按钮、确认条上的点击不能触发「打开原网页」
    if ((e.target as HTMLElement).closest('.it-del, .del-confirm')) return;
    // readme 收藏没有原网页（url 为空），点开的是本地快照阅读页
    if (cap.id === README_ID) {
      void openTab(
        ext.runtime.getURL(`reader.html?id=${encodeURIComponent(cap.id)}`),
      ).catch((e) => console.error('[thoth] open readme failed', e));
      return;
    }
    if (cap.url)
      void openTab(cap.url).catch((e) =>
        console.error('[thoth] open capture failed', e),
      );
  });
  el.querySelector('.it-del')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (deleteConfirm) askDelete(el, cap);
    else void removeCapture(cap.id);
  });
  el.addEventListener('dragstart', (e) => {
    dragging = true;
    hidePreview();
    e.dataTransfer?.setData('text/capture-id', cap.id);
    e.dataTransfer?.setData('text/plain', cap.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragend', () => {
    dragging = false;
  });
  return el;
}

// ---------------- 删除（debug#3） ----------------
function askDelete(el: HTMLElement, cap: Capture): void {
  if (el.querySelector('.del-confirm')) return;
  const bar = document.createElement('div');
  bar.className = 'del-confirm';
  bar.innerHTML = `<span data-no-i18n>${esc(t('删除「$1」？', truncate(cap.title)))}</span>
    <button type="button" data-ok>删除</button>
    <button type="button" data-cancel>取消</button>`;
  el.appendChild(bar);
  applyI18n(bar);
  el.classList.add('deleting');
  bar.querySelector('[data-ok]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    void removeCapture(cap.id);
  });
  bar.querySelector('[data-cancel]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    bar.remove();
    el.classList.remove('deleting');
  });
}

function truncate(s: string): string {
  return s.length > 18 ? s.slice(0, 18) + '…' : s;
}

async function removeCapture(id: string): Promise<void> {
  hidePreview();
  // 走 repo：真删本地记录并留墓碑，下次同步把删除意图传到云端
  await removeCaptureRecord(id);
  // 只删收藏，不动本地离线资源（按 URL 全局去重，可能被其它收藏引用）
  await bumpRevision();
  refresh();
}

// ---------------- 过滤与计数 ----------------
async function getFiltered(): Promise<Capture[]> {
  let caps = await db.captures.orderBy('createdAt').reverse().toArray();
  if (state.filter.kind === 'business') {
    const id = state.filter.id;
    const isDefault =
      state.business.find((b) => b.id === id)?.name === DEFAULT_FOLDER_NAME;
    caps = caps.filter(
      (c) => c.folderId === id || (isDefault && c.folderId === null),
    );
  } else if (state.filter.kind === 'tag') {
    const id = state.filter.id;
    caps = caps.filter((c) => c.tags.includes(id));
  }
  if (state.activeTags.size > 0) {
    const wanted = [...state.activeTags];
    caps = caps.filter((c) => wanted.some((t) => c.tags.includes(t)));
  }
  const q = state.query.trim().toLowerCase();
  if (q) {
    caps = caps.filter((c) =>
      (c.title + '\n' + c.url + '\n' + c.text).toLowerCase().includes(q),
    );
  }
  return caps;
}

function filterTitle(): string {
  if (state.filter.kind === 'business') {
    const id = state.filter.id;
    const name = state.business.find((b) => b.id === id)?.name;
    return name ? folderLabel(name) : t('收藏');
  }
  if (state.filter.kind === 'tag') {
    const id = state.filter.id;
    const name = state.tags.find((x) => x.id === id)?.name;
    return '#' + (name ? folderLabel(name) : '');
  }
  return t('全部收藏');
}

// ---------------- 悬停预览 ----------------
function hidePreview(): void {
  const msg: ThothPreviewHideMsg = {
    source: 'thothsyn-library',
    type: 'THOTH_PREVIEW_HIDE',
  };
  window.parent.postMessage(msg, '*');
}

// ---------------- 树交互（切换过滤 + 拖拽分类） ----------------
function wireTree(tree: HTMLElement) {
  tree.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const node = (e.target as HTMLElement).closest('.node') as HTMLElement | null;
    if (!node) return;
    e.preventDefault();
    node.click();
  });
  tree.addEventListener('click', (e) => {
    const node = (e.target as HTMLElement).closest('.node') as HTMLElement | null;
    if (!node) return;
    if (node.dataset.filter === 'all') state.filter = { kind: 'all' };
    else if (node.dataset.biz)
      state.filter = { kind: 'business', id: node.dataset.biz };
    else if (node.dataset.tag)
      state.filter = { kind: 'tag', id: node.dataset.tag };
    render();
  });

  tree.addEventListener('dragover', (e) => {
    const node = (e.target as HTMLElement).closest('.node') as HTMLElement | null;
    if (node?.dataset.biz || node?.dataset.tag) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      tree.querySelectorAll('.node.drop').forEach((n) => n.classList.remove('drop'));
      node.classList.add('drop');
    }
  });
  tree.addEventListener('dragleave', () => {
    tree.querySelectorAll('.node.drop').forEach((n) => n.classList.remove('drop'));
  });
  tree.addEventListener('drop', async (e) => {
    e.preventDefault();
    const node = (e.target as HTMLElement).closest('.node') as HTMLElement | null;
    const id =
      e.dataTransfer?.getData('text/capture-id') ||
      e.dataTransfer?.getData('text/plain');
    if (!node || !id) return;
    tree.querySelectorAll('.node.drop').forEach((n) => n.classList.remove('drop'));
    const cap = await db.captures.get(id);
    if (!cap) return;
    if (node.dataset.biz) {
      await patchCapture(id, { folderId: node.dataset.biz });
    } else if (node.dataset.tag) {
      const tags = cap.tags.includes(node.dataset.tag)
        ? cap.tags
        : [...cap.tags, node.dataset.tag];
      await patchCapture(id, { tags });
    }
    await bumpRevision();
    refresh();
  });
}

// ---------------- 工具 ----------------
function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
}

// ---------------- 筛选树宽度（可拖拽，持久化） ----------------
let treeWidth = 220;
function mountTreeSplitter(tree: HTMLElement): void {
  const sp = document.createElement('div');
  sp.className = 'splitter';
  sp.title = '拖动调整侧边栏宽度';
  tree.appendChild(sp);
  sp.addEventListener('mousedown', (e: MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = treeWidth;
    sp.classList.add('dragging');
    const move = (ev: MouseEvent) => {
      treeWidth = Math.min(Math.max(startW + ev.clientX - startX, 160), 420);
      app.style.gridTemplateColumns = treeWidth + 'px 1fr';
    };
    const up = () => {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
      sp.classList.remove('dragging');
      void ext.storage.local.set({ thothTreeWidth: treeWidth });
    };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
  });
}

// ---------------- 刷新（防抖 + 保留搜索输入态） ----------------
let refreshTimer = 0;
function refresh(): void {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    const active = document.activeElement as HTMLInputElement | null;
    const wasSearch = active?.classList.contains('search') ?? false;
    const caret = wasSearch ? active!.selectionStart : null;
    void loadData().then(() => {
      render();
      if (wasSearch) {
        const next = app.querySelector<HTMLInputElement>('.search');
        next?.focus();
        if (caret != null) next?.setSelectionRange(caret, caret);
      }
    });
  }, 100);
}

/**
 * debug#2 主通道：任何写入 Dexie 的地方都 bump 一个 storage 版本号。
 * ext.storage.onChanged 对网页内的扩展 iframe 可靠投递，
 * 而 Service Worker 的 runtime.sendMessage 不保证（旧版偶发不刷新）。
 * 监听器放在模块顶层同步注册，避免 iframe 初始化期间漏事件。
 */
ext.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[REVISION_KEY]) refresh();
  if (changes[DELETE_CONFIRM_KEY])
    deleteConfirm = needsDeleteConfirm(changes[DELETE_CONFIRM_KEY].newValue);
});

ext.runtime.onMessage.addListener((msg: unknown) => {
  const m = msg as { type?: string } | undefined;
  // runtime 消息保留为冗余通道，与 storage 版本号并存
  if (m?.type === 'CAPTURE_SAVED' || m?.type === 'FOLDERS_CHANGED') refresh();
  if (m?.type === 'ASSETS_CHANGED') {
    // 有新资源落地：让缓存失效，下次悬停重新内联一次；下载风暴期间
    // 同一条目仍走 lastPreviewId 复用，不会每次广播都重建 srcdoc。
    invalidateOfflineCache();
    previewDirty = true;
  }
});

// ---------------- 初始化 ----------------
async function init() {
  const saved = await ext.storage.local.get('thothTreeWidth');
  treeWidth = Math.min(
    Math.max(Number(saved.thothTreeWidth) || 220, 160),
    420,
  );
  app.style.gridTemplateColumns = treeWidth + 'px 1fr';
  deleteConfirm = await getBool(DELETE_CONFIRM_KEY, false);
  await loadData();
  render();
  applyI18n(document); // 页面标题与 #app 之外的静态文案

  document.addEventListener('keydown', (e) => {
    if (e.key !== '/') return;
    const t = e.target as HTMLElement | null;
    if (
      t &&
      (t.tagName === 'INPUT' ||
        t.tagName === 'TEXTAREA' ||
        t.isContentEditable)
    )
      return;
    const s = app.querySelector<HTMLInputElement>('.search');
    if (!s) return;
    e.preventDefault();
    s.focus();
    s.select();
  });
}

void init();
