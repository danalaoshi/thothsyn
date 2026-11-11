import './options.css';
import { db } from '../../db/database';
import type { Folder, FolderType } from '../../types';
import { listBusinessFolders, listTagFolders } from '../../lib/seed';
import {
  assetStats,
  formatBytes,
  MAX_TOTAL_BYTES,
  resetBytesCache,
} from '../../lib/assets';
import { importFromBookmarks, importFromHtmlFile } from '../../lib/import';
import { addFolder, patchCapture, patchFolder, removeFolder } from '../../lib/repo';
import { applyI18n, folderLabel, t } from '../../lib/i18n';
import {
  bumpRevision,
  DELETE_CONFIRM_KEY,
  getBool,
  ICON_BLINK_KEY,
  needsDeleteConfirm,
  setBool,
} from '../../lib/settings';
import type { AssetsChangedMsg, FoldersChangedMsg } from '../../lib/messages';
import {
  ensureFreshSession,
  getAutoSync,
  getMeta,
  getServerUrl,
  getSession,
  getSyncMode,
  LEVEL_LABEL,
  recoverPassword,
  setAutoSync,
  setServerUrl,
  setSyncMode,
  signIn,
  signOut,
  signUp,
  syncNow,
  type AuthSession,
  type Level,
  type SyncMode,
} from '../../lib/sync';

const app = document.querySelector<HTMLDivElement>('#app')!;

async function render() {
  const [business, tags, delConfirm, iconBlink] = await Promise.all([
    listBusinessFolders(),
    listTagFolders(),
    getBool(DELETE_CONFIRM_KEY, false),
    getBool(ICON_BLINK_KEY, true),
  ]);

  app.innerHTML = `
    <h1>Thothsyn 设置</h1>
    <p class="sub">管理本地收藏的分类文件夹、导入与偏好。改动会即时同步到收藏库；登录与云同步为 v2 功能，当前为占位。</p>

    <div class="card" id="card-biz">
      <h2>管理业务文件夹 <span class="hint">单归属：每个收藏只属于一个业务文件夹（拖入=移动）</span></h2>
      <div class="list"></div>
      <div class="add"><button class="btn primary sm" data-add="business">+ 新建业务文件夹</button></div>
    </div>
    <div class="card" id="card-tag">
      <h2>管理标签文件夹 <span class="hint">多标签：收藏可同时属于多个标签文件夹（拖入=追加标签）</span></h2>
      <div class="list"></div>
      <div class="add"><button class="btn primary sm" data-add="tag">+ 新建标签文件夹</button></div>
    </div>

    <div class="card" id="card-import">
      <h2>导入收藏 <span class="hint">从书签栏或书签 HTML 文件导入，记录与原有收藏独立</span></h2>
      <div class="import-actions">
        <button class="btn primary sm" data-import="bar">从书签栏导入</button>
        <label class="btn sm file-btn">从 HTML 文件导入
          <input type="file" accept=".html,.htm" data-import="file" hidden />
        </label>
        <span class="hint">顶层「书签栏」归入业务文件夹，子文件夹作为标签</span>
      </div>
      <div class="import-result" id="import-result" role="status" aria-live="polite"></div>
    </div>

    <div class="card" id="card-prefs">
      <h2>偏好 <span class="hint">即时生效，无需重启扩展</span></h2>
      <label class="pref-row">
        <span class="pref-meta">
          <b>删除收藏时二次确认</b>
          <small>默认关闭：点每条收藏右侧的 × 直接删除。开启后先出现行内确认条。</small>
        </span>
        <input type="checkbox" id="pref-del-confirm" ${delConfirm ? 'checked' : ''}
               aria-label="删除收藏时是否需要二次确认" />
        <span class="switch" aria-hidden="true"></span>
      </label>
      <div class="pref-state" id="del-confirm-state"></div>
      <label class="pref-row">
        <span class="pref-meta">
          <b>工具栏图标闪烁</b>
          <small>同一蓝色相的两帧图标交替切换；关闭后回到静态图标。尊重系统「减少动态效果」。</small>
        </span>
        <input type="checkbox" id="pref-icon-blink" ${iconBlink ? 'checked' : ''}
               aria-label="工具栏图标是否闪烁" />
        <span class="switch" aria-hidden="true"></span>
      </label>
      <div class="pref-state" id="icon-blink-state"></div>
    </div>

    <div class="card" id="card-assets">
      <h2>离线资源 <span class="hint">保存网页时后台下载图片 / CSS / 字体，脚本仅存档不执行</span></h2>
      <div class="asset-stats" id="asset-stats"><span class="stat-line">读取中…</span></div>
      <div class="asset-actions">
        <button class="btn sm danger" data-clear-assets>清空离线资源</button>
        <span class="hint">只删缓存，收藏与分类不受影响</span>
      </div>
    </div>

    <div class="card" id="card-account">
      <h2>账号与云同步 <span class="hint">邮箱登录后，收藏可跨设备同步；未验证邮箱不允许同步</span></h2>
      <div id="account-body"><span class="hint">读取账号状态…</span></div>
    </div>
  `;

  fillFolderList(app.querySelector('#card-biz .list')!, business, 'business');
  fillFolderList(app.querySelector('#card-tag .list')!, tags, 'tag');

  app.querySelectorAll<HTMLButtonElement>('[data-add]').forEach((btn) => {
    btn.addEventListener('click', () =>
      inlineAdd(btn.parentElement as HTMLElement, btn.dataset.add as FolderType),
    );
  });

  wireImportCard();
  wirePrefs();
  void renderAssetStats();
  wireAssetCard();
  void renderAccount();
  // 静态文案（标题、卡片、按钮、aria-label、placeholder）自动跟随浏览器语言
  applyI18n(app);
}

// ---- 偏好开关：写入后立刻读回展示「当前生效值」，便于验证 debug#3 ----
function wirePrefs(): void {
  const delInput = app.querySelector<HTMLInputElement>('#pref-del-confirm')!;
  const blinkInput = app.querySelector<HTMLInputElement>('#pref-icon-blink')!;

  void showPrefStates();
  delInput.addEventListener('change', () => {
    void setBool(DELETE_CONFIRM_KEY, delInput.checked).then(showPrefStates);
  });
  blinkInput.addEventListener('change', () => {
    void setBool(ICON_BLINK_KEY, blinkInput.checked).then(showPrefStates);
  });
}

async function showPrefStates(): Promise<void> {
  const [del, blink] = await Promise.all([
    getBool(DELETE_CONFIRM_KEY, false),
    getBool(ICON_BLINK_KEY, true),
  ]);
  const a = app.querySelector<HTMLElement>('#del-confirm-state');
  const b = app.querySelector<HTMLElement>('#icon-blink-state');
  if (a)
    a.textContent = needsDeleteConfirm(del)
      ? t('当前生效：需要二次确认（到收藏库点 × 验证）')
      : t('当前生效：直接删除（到收藏库点 × 验证）');
  if (b)
    b.textContent = blink
      ? t('当前生效：图标闪烁开启')
      : t('当前生效：静态图标');
}

// ---- 导入完成反馈（debug#2） ----
// toast 在 #app 之外，render() 重建设置页时不会把「已完成」抹掉。
type ToastKind = 'ok' | 'error' | 'info';
let toastTimer = 0;
function showToast(text: string, kind: ToastKind): void {
  const el = document.querySelector<HTMLElement>('#toast');
  if (!el) return;
  el.textContent = text;
  el.dataset.kind = kind;
  el.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 4200);
}

// ---- 导入（入口在设置页） ----
function wireImportCard(): void {
  const card = app.querySelector<HTMLElement>('#card-import')!;
  const result = card.querySelector<HTMLElement>('#import-result')!;
  const say = (text: string, kind: ToastKind) => {
    result.textContent = text;
    showToast(text, kind);
  };

  card.querySelector<HTMLButtonElement>('[data-import="bar"]')?.addEventListener(
    'click',
    () => {
      say(t('正在从书签栏导入…'), 'info');
      void importFromBookmarks()
        .then((n) =>
          n > 0
            ? say(t('导入完成：新增 $1 条收藏，顶层书签栏已归入业务文件夹', n), 'ok')
            : say(t('导入完成：书签栏里没有可导入的链接'), 'ok'),
        )
        .catch((e) => say(t('导入失败：$1', String(e)), 'error'));
    },
  );
  card
    .querySelector<HTMLInputElement>('[data-import="file"]')
    ?.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      say(t('正在解析 $1 …', file.name), 'info');
      void importFromHtmlFile(file)
        .then((n) =>
          n > 0
            ? say(t('导入完成：从 $1 新增 $2 条收藏', file.name, n), 'ok')
            : say(t('导入完成：$1 里没有可导入的链接', file.name), 'ok'),
        )
        .catch((err) => say(t('导入失败：$1', String(err)), 'error'));
    });
}

// ---- 离线资源占用：让「本地空间慢慢长」可见、可控 ----
async function renderAssetStats(): Promise<void> {
  const host = document.querySelector<HTMLElement>('#asset-stats');
  if (!host) return;
  const s = await assetStats();
  const pct = Math.min(100, (s.bytes / MAX_TOTAL_BYTES) * 100);
  const notes = [
    s.pending ? t('下载中 $1', s.pending) : '',
    s.failed ? t('失败 $1', s.failed) : '',
    s.awaiting ? t('待放行 $1', s.awaiting) : '',
  ].filter(Boolean);
  host.innerHTML = `
    <div class="stat-line"><span class="num">${s.count}</span> ${t('份已离线 ·')}
      <span class="num">${formatBytes(s.bytes)}</span> / ${formatBytes(MAX_TOTAL_BYTES)}</div>
    <div class="meter"><i style="width:${pct.toFixed(1)}%"></i></div>
    <div class="stat-line muted">${t('图片 $1 · 样式 $2 · 字体 $3 · 脚本存档 $4（不执行）', s.images, s.styles, s.fonts, s.scripts)}</div>
    <div class="stat-line muted">${notes.length ? esc(notes.join(' · ')) + ' · ' : ''}${t('按原始 URL 全局去重，同一份资源只存一份')}</div>`;
  applyI18n(host);
}

function wireAssetCard(): void {
  const card = document.querySelector<HTMLElement>('#card-assets');
  const btn = card?.querySelector<HTMLButtonElement>('[data-clear-assets]');
  btn?.addEventListener('click', () => {
    const actions = card?.querySelector<HTMLElement>('.asset-actions');
    if (!actions || actions.querySelector('.inline-form')) return;
    const form = document.createElement('div');
    form.className = 'inline-form';
    form.innerHTML = `
      <span class="name warn">清空全部离线资源？收藏与分类不受影响。</span>
      <button class="btn sm danger" data-ok>清空</button>
      <button class="btn sm" data-cancel>取消</button>`;
    actions.appendChild(form);
    applyI18n(form);
    form.querySelector('[data-ok]')?.addEventListener('click', () => {
      void (async () => {
        await db.assets.clear();
        resetBytesCache();
        notifyAssetsChanged();
        void bumpRevision();
        await render();
      })();
    });
    form
      .querySelector('[data-cancel]')
      ?.addEventListener('click', () => form.remove());
  });
}

// ---------------- 账号与云同步 ----------------

const MODE_LABEL: Record<SyncMode, string> = {
  both: '双向：各取增量，冲突取更新时间较新的一方',
  push: '仅上传：本地 → 云端',
  pull: '仅下载：云端 → 本地',
};

function acctMsg(text: string, kind: 'ok' | 'error' | 'info' = 'info'): void {
  const el = app.querySelector<HTMLElement>('#acct-msg');
  if (!el) return;
  el.textContent = text;
  el.dataset.kind = kind;
}

function acctField<T extends HTMLElement>(sel: string): T | null {
  return app.querySelector<T>(sel);
}

function fmtTime(ts: number): string {
  if (!ts) return '从未';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

async function renderAccount(): Promise<void> {
  const host = app.querySelector<HTMLElement>('#account-body');
  if (!host) return;
  const serverUrl = await getServerUrl();
  const session = await getSession();

  if (!session) {
    host.innerHTML = `
      <div class="acct-form">
        <label class="field"><span>服务器地址</span>
          <input id="acct-server" type="text" spellcheck="false"
                 value="${esc(serverUrl)}" placeholder="http://127.0.0.1:3000" />
        </label>
        <label class="field"><span>邮箱</span>
          <input id="acct-email" type="email" autocomplete="username" spellcheck="false" placeholder="you@example.com" />
        </label>
        <label class="field"><span>密码</span>
          <input id="acct-pass" type="password" autocomplete="current-password" placeholder="至少 6 位" />
        </label>
      </div>
      <div class="acct-actions">
        <button class="btn primary sm" data-acct="login">登录</button>
        <button class="btn sm" data-acct="register">注册新账号</button>
        <button class="btn sm ghost" data-acct="forgot">忘记密码</button>
      </div>
      <div class="acct-msg" id="acct-msg" role="status" aria-live="polite"></div>
      <div class="hint">注册后需要到邮箱点确认链接；未验证邮箱的账号不允许同步。</div>`;
    wireLoggedOut();
    applyI18n(host);
    return;
  }

  // 令牌可能过期：进页面先刷一次，后面的「管理线上内容」才能拿到可用令牌
  const fresh = (await ensureFreshSession()) ?? session;
  const [mode, auto, meta] = await Promise.all([
    getSyncMode(),
    getAutoSync(),
    getMeta(),
  ]);
  const canSync = fresh.level !== 'unverified';
  const levelTone: Record<Level, string> = {
    unverified: 'warn',
    formal: 'ok',
    paid: 'accent',
    superuser: 'violet',
  };

  host.innerHTML = `
    <div class="acct-id">
      <div class="acct-who">
        <b data-no-i18n>${esc(fresh.email)}</b>
        <span class="acct-server" data-no-i18n>${esc(serverUrl)}</span>
      </div>
      <span class="acct-level ${levelTone[fresh.level]}">${esc(
        t(LEVEL_LABEL[fresh.level]),
      )}</span>
    </div>
    ${
      canSync
        ? ''
        : `<div class="acct-warn">邮箱未验证：同步已禁用。请到注册邮箱点确认链接后再回来。</div>`
    }
    <div class="acct-grid">
      <label class="field"><span>同步模式</span>
        <select id="acct-mode" ${canSync ? '' : 'disabled'}>
          ${(Object.keys(MODE_LABEL) as SyncMode[])
            .map(
              (m) =>
                `<option value="${m}" ${m === mode ? 'selected' : ''}>${esc(
                  t(MODE_LABEL[m]),
                )}</option>`,
            )
            .join('')}
        </select>
      </label>
      <label class="field pref-inline"><span>每日自动同步</span>
        <span class="switch-row">
          <input type="checkbox" id="acct-auto" ${auto ? 'checked' : ''} ${canSync ? '' : 'disabled'} />
          <span class="hint">每天一次，浏览器启动后自动补跑</span>
        </span>
      </label>
    </div>
    <div class="acct-actions">
      <button class="btn primary sm" data-acct="sync" ${canSync ? '' : 'disabled'}>立即同步</button>
      <button class="btn sm" data-acct="manage">管理线上内容</button>
      <button class="btn sm danger" data-acct="logout">退出登录</button>
    </div>
    <div class="acct-meta">
      上次同步：<b>${esc(fmtTime(meta.lastSyncAt))}</b>
      ${meta.lastResult ? `· ${esc(meta.lastResult)}` : ''}
    </div>
    <div class="acct-msg" id="acct-msg" role="status" aria-live="polite"></div>`;

  wireLoggedIn(fresh);
  applyI18n(host);
}

function wireLoggedOut(): void {
  const email = () => acctField<HTMLInputElement>('#acct-email')?.value.trim() ?? '';
  const pass = () => acctField<HTMLInputElement>('#acct-pass')?.value ?? '';
  const server = () =>
    acctField<HTMLInputElement>('#acct-server')?.value.trim() ?? '';

  const guard = async (): Promise<boolean> => {
    if (!email() || !pass()) {
      acctMsg(t('请填写邮箱与密码'), 'error');
      return false;
    }
    await setServerUrl(server());
    return true;
  };

  app.querySelector('[data-acct="login"]')?.addEventListener('click', () => {
    void (async () => {
      if (!(await guard())) return;
      acctMsg(t('正在登录…'));
      try {
        const s = await signIn(email(), pass());
        acctMsg(t('已登录：$1（$2）', s.email, t(LEVEL_LABEL[s.level])), 'ok');
        await renderAccount();
      } catch (e) {
        acctMsg((e as Error).message, 'error');
      }
    })();
  });

  app.querySelector('[data-acct="register"]')?.addEventListener('click', () => {
    void (async () => {
      if (!(await guard())) return;
      acctMsg(t('正在注册…'));
      try {
        const { needsConfirmation } = await signUp(email(), pass());
        if (needsConfirmation) {
          acctMsg(t('已发送确认邮件：请到邮箱点确认链接，然后回来登录'), 'ok');
          return;
        }
        acctMsg(t('注册成功，已自动登录'), 'ok');
        await renderAccount();
      } catch (e) {
        acctMsg((e as Error).message, 'error');
      }
    })();
  });

  app.querySelector('[data-acct="forgot"]')?.addEventListener('click', () => {
    void (async () => {
      if (!email()) {
        acctMsg(t('先填写邮箱，再点忘记密码'), 'error');
        return;
      }
      await setServerUrl(server());
      try {
        await recoverPassword(email());
        acctMsg(t('重置密码邮件已发送（本地测试可在 Mailpit 54324 查看）'), 'ok');
      } catch (e) {
        acctMsg((e as Error).message, 'error');
      }
    })();
  });

  acctField<HTMLInputElement>('#acct-pass')?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      app.querySelector<HTMLButtonElement>('[data-acct="login"]')?.click();
    }
  });
}

function wireLoggedIn(session: AuthSession): void {
  acctField<HTMLSelectElement>('#acct-mode')?.addEventListener('change', (e) => {
    void setSyncMode((e.target as HTMLSelectElement).value as SyncMode);
  });
  acctField<HTMLInputElement>('#acct-auto')?.addEventListener('change', (e) => {
    void setAutoSync((e.target as HTMLInputElement).checked);
  });

  app.querySelector('[data-acct="sync"]')?.addEventListener('click', () => {
    void (async () => {
      const btn = app.querySelector<HTMLButtonElement>('[data-acct="sync"]');
      if (btn) btn.disabled = true;
      acctMsg(t('正在同步…'));
      try {
        const r = await syncNow();
        acctMsg(
          t('同步完成：上传 $1 条、下载 $2 条', r.pushed, r.pulled) +
            (r.conflicts ? t('，$1 条以云端为准', r.conflicts) : ''),
          r.conflicts ? 'info' : 'ok',
        );
        const meta = await getMeta();
        const line = app.querySelector<HTMLElement>('.acct-meta');
        if (line)
          line.innerHTML = `${esc(t('上次同步：'))}<b>${esc(
            fmtTime(meta.lastSyncAt),
          )}</b> · ${esc(meta.lastResult)}`;
      } catch (e) {
        acctMsg((e as Error).message, 'error');
      } finally {
        if (btn) btn.disabled = false;
      }
    })();
  });

  app.querySelector('[data-acct="manage"]')?.addEventListener('click', () => {
    void (async () => {
      const current = (await ensureFreshSession()) ?? session;
      const base = await getServerUrl();
      // 令牌放 hash：不会进服务端日志与 Referer；管理页读取后立刻从地址栏抹掉
      const url =
        `${base}/manage#access_token=${encodeURIComponent(current.accessToken)}` +
        `&refresh_token=${encodeURIComponent(current.refreshToken)}`;
      await chrome.tabs.create({ url });
    })();
  });

  app.querySelector('[data-acct="logout"]')?.addEventListener('click', () => {
    void (async () => {
      await signOut();
      acctMsg(t('已退出登录，本地收藏不受影响'), 'ok');
      await renderAccount();
    })();
  });
}

function fillFolderList(
  host: Element,
  folders: Folder[],
  type: FolderType,
) {
  host.innerHTML = '';
  if (folders.length === 0) {
    host.innerHTML = `<div class="row"><span class="name" style="color:var(--ink-3)">（暂无，点击下方新建）</span></div>`;
    return;
  }
  for (const f of folders) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <span class="name" data-no-i18n>${esc(folderLabel(f.name))}</span>
      <button class="btn sm" data-act="rename">重命名</button>
      <button class="btn sm danger" data-act="delete">删除</button>`;
    row.querySelector('[data-act="rename"]')!.addEventListener('click', () =>
      inlineRename(row, f),
    );
    row.querySelector('[data-act="delete"]')!.addEventListener('click', () =>
      inlineDelete(row, f, type),
    );
    host.appendChild(row);
  }
}

// 不用 prompt / confirm：扩展选项页嵌在 chrome://extensions 内时，
// 浏览器会直接丢弃这类对话框，表现就是「点了没反应」。改成页面内联表单。
function inlineAdd(host: HTMLElement, type: FolderType) {
  if (host.querySelector('.inline-form')) return;
  const form = document.createElement('div');
  form.className = 'inline-form';
  form.innerHTML = `
    <input type="text" maxlength="40" placeholder="${esc(t(type === 'business' ? '业务文件夹名称' : '标签文件夹名称'))}" />
    <button class="btn primary sm" data-ok>确定</button>
    <button class="btn sm" data-cancel>取消</button>`;
  host.appendChild(form);
  applyI18n(form);
  const input = form.querySelector('input')!;
  input.focus();

  const submit = async () => {
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    await addFolder({
      id: crypto.randomUUID(),
      name,
      type,
      createdAt: Date.now(),
    });
    notifyFoldersChanged();
    await render();
  };
  form.querySelector('[data-ok]')!.addEventListener('click', () => void submit());
  form.querySelector('[data-cancel]')!.addEventListener('click', () =>
    form.remove(),
  );
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submit();
    else if (e.key === 'Escape') form.remove();
  });
}

function inlineRename(row: HTMLElement, f: Folder) {
  row.innerHTML = `
    <span class="name"><input type="text" maxlength="40" /></span>
    <button class="btn primary sm" data-ok>保存</button>
    <button class="btn sm" data-cancel>取消</button>`;
  applyI18n(row);
  const input = row.querySelector('input')!;
  input.value = f.name;
  input.focus();
  input.select();

  const save = async () => {
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    await patchFolder(f.id, { name });
    notifyFoldersChanged();
    await render();
  };
  row.querySelector('[data-ok]')!.addEventListener('click', () => void save());
  row.querySelector('[data-cancel]')!.addEventListener('click', () =>
    void render(),
  );
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void save();
    else if (e.key === 'Escape') void render();
  });
}

function inlineDelete(row: HTMLElement, f: Folder, type: FolderType) {
  row.innerHTML = `
    <span class="name warn" data-no-i18n>${esc(t('删除「$1」？收藏不会被删除，只移除该分类。', folderLabel(f.name)))}</span>
    <button class="btn sm danger" data-ok>删除</button>
    <button class="btn sm" data-cancel>取消</button>`;
  applyI18n(row);

  const remove = async () => {
    await removeFolder(f.id);
    if (type === 'business') {
      const caps = await db.captures.where('folderId').equals(f.id).toArray();
      for (const c of caps) await patchCapture(c.id, { folderId: null });
    } else {
      const caps = await db.captures
        .filter((c) => c.tags.includes(f.id))
        .toArray();
      for (const c of caps)
        await patchCapture(c.id, {
          tags: c.tags.filter((t) => t !== f.id),
        });
    }
    notifyFoldersChanged();
    await render();
  };
  row.querySelector('[data-ok]')!.addEventListener('click', () => void remove());
  row.querySelector('[data-cancel]')!.addEventListener('click', () =>
    void render(),
  );
}

// ---- 与收藏库即时同步 ----
/**
 * 主通道是 storage 数据版本号（对网页内扩展 iframe 可靠）；
 * runtime 消息保留冗余。收藏库未打开时没有接收端，静默忽略。
 */
function notifyFoldersChanged(): void {
  void bumpRevision().catch(() => {});
  const msg: FoldersChangedMsg = { type: 'FOLDERS_CHANGED' };
  void Promise.resolve(chrome.runtime.sendMessage(msg)).catch(() => {});
}

function notifyAssetsChanged(): void {
  const msg: AssetsChangedMsg = { type: 'ASSETS_CHANGED' };
  void Promise.resolve(chrome.runtime.sendMessage(msg)).catch(() => {});
}

let assetStatsTimer = 0;
chrome.runtime.onMessage.addListener((msg: unknown) => {
  const m = msg as { type?: string } | undefined;
  if (m?.type === 'ASSETS_CHANGED') {
    window.clearTimeout(assetStatsTimer);
    assetStatsTimer = window.setTimeout(() => void renderAssetStats(), 400);
  }
});

// 偏好开关可能在别的上下文被改，读回展示，保证「当前生效」不撒谎
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[DELETE_CONFIRM_KEY] || changes[ICON_BLINK_KEY])
    void showPrefStates();
});

let syncTimer = 0;
function showSyncStatus(text: string): void {
  const el = document.querySelector<HTMLElement>('#sync-status');
  if (!el) return;
  el.textContent = text;
  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => {
    el.textContent = '';
  }, 2400);
}

/**
 * debug#1：点「完成」先同步，再关闭设置页。
 * options_ui.open_in_tab=true 时这是普通标签页，可直接移除；
 * 万一仍是嵌入 iframe（旧配置 / 浏览器差异），退化为淡出隐藏，
 * 保证用户看到的都是「设置页消失」。
 */
async function finishAndClose(): Promise<void> {
  notifyFoldersChanged();
  await bumpRevision().catch(() => {});
  showSyncStatus(t('已同步 · 正在关闭'));
  await new Promise((r) => setTimeout(r, 320));
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id != null) {
      await chrome.tabs.remove(tab.id);
      return;
    }
  } catch {
    // 嵌入模式没有可移除的标签页，走下面的视觉兜底
  }
  try {
    window.close();
  } catch {
    // 忽略：浏览器可能拒绝关闭非脚本打开的窗口
  }
  document.body.classList.add('closing');
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

document
  .querySelector<HTMLButtonElement>('#done-btn')
  ?.addEventListener('click', () => void finishAndClose());

applyI18n(document); // 页面标题、dock 的「完成」按钮与 title
void render();
