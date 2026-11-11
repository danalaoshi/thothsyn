import { defineContentScript } from 'wxt/utils/define-content-script';
import type {
  CaptureFullResult,
  StartPartialMsg,
  CaptureFullMsg,
  LibraryState,
  LibraryStateMsg,
  LibrarySetStateMsg,
  IconBlinkStateMsg,
  ThothPreviewMsg,
  ThothPreviewShowMsg,
} from '../lib/messages';
import { applyI18n, t } from '../lib/i18n';

type IncomingMsg =
  | CaptureFullMsg
  | StartPartialMsg
  | LibraryStateMsg
  | IconBlinkStateMsg
  | { type: 'THOTH_PING' };

const HOVER_CLS = 'thoth-hover';
const STAGING_CLS = 'thoth-staging';
const SELECTED_CLS = 'thoth-selected';
const SKIP_TAGS = new Set([
  'html', 'body', 'head', 'script', 'style', 'noscript',
  'iframe', 'link', 'meta', 'title', 'br',
]);
// 插件自身 UI 一律不能被框选命中（抽屉是 shadow DOM，命中测试会返回 host 本身）
const OUR_UI =
  '#thoth-select-bar, #thoth-select-rect, #thoth-select-overlay, #thoth-library-host';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main(ctx) {
    // ---- 整页采集 ----
    function captureFull(): CaptureFullResult {
      // 在副本上清理，不改动正在浏览的页面：
      // 1) 停靠时给 <html> 加的 margin-left / width / transition 不能存进快照，
      //    否则离线预览里正文会被挤窄；按 pushOriginal 还原页面原本的内联值。
      // 2) 插件自己注入的 UI 节点不进快照（shadow DOM 本身不会被 cloneNode 复制）。
      const root = document.documentElement.cloneNode(true) as HTMLElement;
      if (pushOriginal) {
        for (const key of ['margin-left', 'width', 'transition'] as const) {
          const o = pushOriginal[key];
          if (o?.value) root.style.setProperty(key, o.value, o.priority);
          else root.style.removeProperty(key);
        }
      }
      root
        .querySelectorAll(
          '#thoth-library-host, #thoth-select-bar, #thoth-select-rect, #thoth-select-overlay',
        )
        .forEach((n) => n.remove());
      return {
        title: document.title,
        url: location.href,
        html: root.outerHTML,
        text: (document.body?.innerText ?? '').slice(0, 20000),
      };
    }

    function escapeHtml(s: string): string {
      return s.replace(
        /[&<>"']/g,
        (c) =>
          ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
      );
    }

    /** 把多个选中片段整合成一个可直接阅读的完整 HTML 页面 */
    function buildSnapshotHtml(
      title: string,
      url: string,
      fragments: string,
    ): string {
      return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body{margin:0;padding:24px 28px;max-width:860px;font:16px/1.7 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1c2024;background:#fff;}
  h1{font-size:22px;margin:0 0 8px;}
  .thoth-meta{margin:0 0 20px;padding-bottom:12px;border-bottom:1px solid #e4e6ea;color:#626a74;font-size:13px;word-break:break-all;}
  .thoth-meta a{color:#185fa5;}
  .thoth-fragment{margin-bottom:18px;padding:12px 14px;border:1px solid #e4e6ea;border-radius:8px;}
  img{max-width:100%;height:auto;}
</style></head><body>
<h1>${escapeHtml(title)}</h1>
<p class="thoth-meta">${t('来源：')}<a href="${escapeHtml(url)}">${escapeHtml(url)}</a> · ${t('Thothsyn 部分保存')}</p>
<div class="thoth-fragment">${fragments}</div>
</body></html>`;
    }

    // ---- 部分保存：单击选中 + 拖拽框选，两者都铺浅蓝遮罩 ----
    function startPartialSelect() {
      if (document.getElementById('thoth-select-overlay')) return;

      const style = document.createElement('style');
      style.textContent = `
        /* 悬停=虚线预览，框选过程=浅蓝，确认选中=更深的浅蓝；三级都是同一色相 */
        .${HOVER_CLS}{outline:2px dashed #185FA5 !important;outline-offset:-2px;background:rgba(24,95,165,.06) !important;}
        .${STAGING_CLS}{outline:2px solid #185FA5 !important;outline-offset:-2px;background:rgba(24,95,165,.14) !important;}
        .${SELECTED_CLS}{outline:2px solid #185FA5 !important;outline-offset:-2px;background:rgba(24,95,165,.20) !important;}
        /* 遮罩层纯视觉：不拦截命中测试，否则 elementFromPoint 永远只命中自己 */
        #thoth-select-overlay{position:fixed;inset:0;z-index:2147483646;pointer-events:none;background:transparent;}
        #thoth-select-rect{position:fixed;border:2px solid #185FA5;background:rgba(24,95,165,.10);display:none;pointer-events:none;z-index:2147483647;}
        #thoth-select-bar{position:fixed;right:16px;bottom:16px;z-index:2147483647;pointer-events:auto;display:flex;gap:10px;align-items:center;
          background:#171b21;color:#fff;padding:10px 14px;border-radius:10px;font:14px/1.2 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);}
        #thoth-select-bar .thoth-tip{color:#9aa4b2;font-size:12px;}
        #thoth-select-bar button{border:0;border-radius:8px;padding:6px 12px;font:13px system-ui;cursor:pointer;}
        #thoth-select-bar .ok{background:#185FA5;color:#fff;}
        #thoth-select-bar .cancel{background:#3a3f47;color:#cfd4da;}
      `;
      document.head.appendChild(style);

      const overlay = document.createElement('div');
      overlay.id = 'thoth-select-overlay';
      const rect = document.createElement('div');
      rect.id = 'thoth-select-rect';
      const bar = document.createElement('div');
      bar.id = 'thoth-select-bar';
      bar.innerHTML = `<span class="thoth-tip">悬停高亮 · 单击选中 · 拖拽框选 · Esc 退出</span>
        <span id="thoth-count">${t('已选 $1 个', 0)}</span>
        <button class="ok">保存选中</button><button class="cancel">取消</button>`;
      applyI18n(bar); // 只翻自己的选择条，不碰宿主网页的任何文本
      overlay.append(rect, bar);
      document.documentElement.appendChild(overlay);

      const selected = new Set<HTMLElement>();
      const candidates: HTMLElement[] = [];
      document.body.querySelectorAll<HTMLElement>('*').forEach((el) => {
        if (isCandidate(el)) candidates.push(el);
      });

      let startX = 0;
      let startY = 0;
      let selecting = false;
      let rafId = 0;
      let pendingRect: Rect | null = null;
      let lastHover: HTMLElement | null = null;
      let staging: HTMLElement[] = [];

      function isCandidate(el: Element | null): el is HTMLElement {
        return (
          el instanceof HTMLElement &&
          !SKIP_TAGS.has(el.tagName.toLowerCase()) &&
          !el.closest(OUR_UI)
        );
      }

      function hasSize(el: HTMLElement): boolean {
        const r = el.getBoundingClientRect();
        return r.width > 4 && r.height > 4;
      }

      function isSelectable(el: Element | null): el is HTMLElement {
        return el !== null && isCandidate(el) && hasSize(el);
      }

      function isOurUI(target: EventTarget | null): boolean {
        return target instanceof Element && !!target.closest(OUR_UI);
      }

      function clearHover() {
        lastHover?.classList.remove(HOVER_CLS);
        lastHover = null;
      }

      function clearStaging() {
        staging.forEach((el) => el.classList.remove(STAGING_CLS));
        staging = [];
      }

      function updateCount() {
        (bar.querySelector('#thoth-count') as HTMLElement).textContent =
          t('已选 $1 个', selected.size);
      }

      function syncSelected() {
        selected.forEach((el) => el.classList.add(SELECTED_CLS));
      }

      /** 矩形命中的元素；剪掉「包含其它命中元素」的祖先，避免把整页选进来 */
      function collectInRect(rc: Rect): HTMLElement[] {
        const hits: HTMLElement[] = [];
        for (const el of candidates) {
          const r = el.getBoundingClientRect();
          if (r.width <= 4 || r.height <= 4) continue;
          if (
            r.left < rc.x + rc.w && r.left + r.width > rc.x &&
            r.top < rc.y + rc.h && r.top + r.height > rc.y
          ) hits.push(el);
        }
        const hitSet = new Set(hits);
        const ancestors = new Set<HTMLElement>();
        for (const el of hits) {
          let p = el.parentElement;
          while (p && hitSet.has(p)) {
            ancestors.add(p);
            p = p.parentElement;
          }
        }
        return hits.filter((el) => !ancestors.has(el));
      }

      /** 拖拽过程中实时铺浅蓝遮罩，rAF 节流避免每帧全量 DOM 扫描两次 */
      function scheduleStaging(rc: Rect) {
        pendingRect = rc;
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          if (!pendingRect) return;
          clearStaging();
          staging = collectInRect(pendingRect).filter((el) => !selected.has(el));
          staging.forEach((el) => el.classList.add(STAGING_CLS));
        });
      }

      function onMouseMove(e: MouseEvent) {
        if (selecting) {
          const rc: Rect = {
            x: Math.min(e.clientX, startX),
            y: Math.min(e.clientY, startY),
            w: Math.abs(e.clientX - startX),
            h: Math.abs(e.clientY - startY),
          };
          Object.assign(rect.style, {
            display: 'block',
            left: `${rc.x}px`,
            top: `${rc.y}px`,
            width: `${rc.w}px`,
            height: `${rc.h}px`,
          });
          if (rc.w > 4 || rc.h > 4) scheduleStaging(rc);
          return;
        }
        if (isOurUI(e.target)) return;
        clearHover();
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (isSelectable(el) && !selected.has(el)) {
          el.classList.add(HOVER_CLS);
          lastHover = el;
        }
      }

      function onMouseDown(e: MouseEvent) {
        if (isOurUI(e.target)) return; // 底部按钮条要能正常点击
        selecting = true;
        startX = e.clientX;
        startY = e.clientY;
        clearHover();
        e.preventDefault(); // 防止原页面文本选中 / 链接跳转干扰框选
      }

      function onMouseUp(e: MouseEvent) {
        if (!selecting) return;
        selecting = false;
        rect.style.display = 'none';
        pendingRect = null;
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
        clearStaging();
        clearHover();

        const w = Math.abs(e.clientX - startX);
        const h = Math.abs(e.clientY - startY);
        if (w < 5 && h < 5) {
          // 单击：点哪个 DOM 就选中哪个；再点一次取消
          const el = document.elementFromPoint(e.clientX, e.clientY);
          if (isSelectable(el)) {
            if (selected.has(el)) {
              selected.delete(el);
              el.classList.remove(SELECTED_CLS);
            } else {
              selected.add(el);
              el.classList.add(SELECTED_CLS);
            }
            updateCount();
          }
          return;
        }
        // 拖拽：矩形内元素全部选中并铺浅蓝遮罩
        collectInRect({
          x: Math.min(e.clientX, startX),
          y: Math.min(e.clientY, startY),
          w,
          h,
        }).forEach((el) => selected.add(el));
        syncSelected();
        updateCount();
      }

      function onKeyDown(e: KeyboardEvent) {
        if (e.key === 'Escape') cleanup();
      }

      function cleanup() {
        document.removeEventListener('mousemove', onMouseMove, true);
        document.removeEventListener('mousedown', onMouseDown, true);
        document.removeEventListener('mouseup', onMouseUp, true);
        document.removeEventListener('keydown', onKeyDown, true);
        if (rafId) cancelAnimationFrame(rafId);
        clearStaging();
        clearHover();
        selected.forEach((el) => el.classList.remove(SELECTED_CLS));
        overlay.remove();
        style.remove();
      }

      document.addEventListener('mousemove', onMouseMove, true);
      document.addEventListener('mousedown', onMouseDown, true);
      document.addEventListener('mouseup', onMouseUp, true);
      document.addEventListener('keydown', onKeyDown, true);

      bar.querySelector('.ok')?.addEventListener('click', () => {
        if (selected.size === 0) {
          cleanup();
          return;
        }
        const fragments = [...selected]
          .map((el) => {
            const clone = el.cloneNode(true) as HTMLElement;
            clone
              .querySelectorAll('script,style,noscript,iframe,link,meta')
              .forEach((n) => n.remove());
            clone.classList.remove(HOVER_CLS, STAGING_CLS, SELECTED_CLS);
            clone
              .querySelectorAll(`.${HOVER_CLS},.${STAGING_CLS},.${SELECTED_CLS}`)
              .forEach((n) =>
                n.classList.remove(HOVER_CLS, STAGING_CLS, SELECTED_CLS),
              );
            return clone.outerHTML;
          })
          .join('\n');
        const text = [...selected]
          .map((el) => el.innerText)
          .join('\n')
          .slice(0, 20000);
        const title = document.title;
        const url = location.href;
        cleanup();
        chrome.runtime.sendMessage({
          type: 'PARTIAL_RESULT',
          title,
          url,
          html: buildSnapshotHtml(title, url, fragments),
          text,
        });
      });

      bar.querySelector('.cancel')?.addEventListener('click', cleanup);
    }

    // ---- 收藏库：网页内左侧抽屉，默认「自动隐藏模式」 ----
    // 不用 mouseleave：鼠标进入 iframe 后父文档收不到鼠标事件，会误判为离开。
    // 改为在 document capture 阶段看指针 x 坐标：左边缘滑出、离开面板区收起。
    const LIB_HOT = 14;
    const BAR_H = 34;
    let libState: LibraryState = { open: false, pinned: false, width: 360 };
    let libHost: HTMLElement | null = null;
    let libDock: HTMLElement | null = null;
    let libFrame: HTMLIFrameElement | null = null;
    let libPreview: HTMLElement | null = null;
    let libPointerInside = false;
    let libPreviewHovering = false;
    let libResizing = false;
    let libDragStartX = 0;
    let libDragStartW = 0;
    let pvLastY = 40;
    let pvCurrentId = '';
    let pvHideTimer = 0;
    let pvEscBound = false;
    let hideTimer = 0;
    let revealTimer = 0;

    // ---------------- 挤占式停靠（debug#2 / 0.1.7） ----------------
    // 抽屉原先是 fixed 浮层，会盖住网页内容。展开/固定时给宿主 <html> 预留
    // 左侧宽度并把页面宽度收窄，让内容被「挤」到右边（类似 DevTools 停靠）。
    // 注意：content script 不能改变浏览器视口，只能重排文档；网页里自己的
    // position:fixed 元素仍按视口定位，这是浏览器层面的能力边界。
    const PUSH_KEYS = ['margin-left', 'width', 'transition'] as const;
    let pushOriginal:
      | Record<string, { value: string; priority: string }>
      | null = null;
    let pushActive = false;

    function libEnsurePushBase(): void {
      if (pushOriginal) return;
      const s = document.documentElement.style;
      pushOriginal = {};
      for (const key of PUSH_KEYS) {
        pushOriginal[key] = {
          value: s.getPropertyValue(key),
          priority: s.getPropertyPriority(key),
        };
      }
      // 只给这两个属性加过渡，避免覆盖页面自身的动画语义
      const noAnim = window.matchMedia(
        '(prefers-reduced-motion: reduce)',
      ).matches;
      if (!noAnim) {
        s.setProperty(
          'transition',
          'margin-left .22s cubic-bezier(.22,1,.36,1), width .22s cubic-bezier(.22,1,.36,1)',
          'important',
        );
      }
    }

    /** width=null 表示收起：还原成页面原本的内联值 */
    function libSetPagePush(width: number | null): void {
      if (!pushOriginal) return;
      const s = document.documentElement.style;
      for (const key of ['margin-left', 'width'] as const) {
        if (width == null) {
          const o = pushOriginal[key];
          if (o.value) s.setProperty(key, o.value, o.priority);
          else s.removeProperty(key);
        } else {
          s.setProperty(
            key,
            key === 'margin-left'
              ? width + 'px'
              : `calc(100% - ${width}px)`,
            'important',
          );
        }
      }
      pushActive = width != null;
    }

    function libRestorePagePush(): void {
      if (!pushOriginal) return;
      const s = document.documentElement.style;
      for (const key of PUSH_KEYS) {
        const o = pushOriginal[key];
        if (o.value) s.setProperty(key, o.value, o.priority);
        else s.removeProperty(key);
      }
      pushOriginal = null;
      pushActive = false;
    }

    function libExpand(): void {
      window.clearTimeout(hideTimer);
      libEnsurePushBase();
      libSetPagePush(libState.width);
      if (libDock) libDock.dataset.expanded = 'true';
    }

    function libCollapse(): void {
      window.clearTimeout(hideTimer);
      if (libState.pinned) return;
      libSetPagePush(null);
      if (libDock) libDock.dataset.expanded = 'false';
    }

    function libScheduleCollapse(): void {
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(libCollapse, 260);
    }

    /** 右键刚打开：先完整展开让人看见，随后自动转入隐藏模式 */
    function libReveal(): void {
      libExpand();
      window.clearTimeout(revealTimer);
      revealTimer = window.setTimeout(() => {
        if (libState.pinned) return;
        // 鼠标停在面板/iframe 内时不收起（iframe 内不会触发父文档 mousemove）
        if (libPointerInside || libPreviewHovering) return;
        libCollapse();
      }, 2400);
    }

    // ---------------- 宽度拖拽 ----------------
    function libApplyWidth(w: number): void {
      const maxW = Math.min(720, Math.max(280, window.innerWidth - 80));
      libState.width = Math.min(Math.max(Math.round(w), 280), maxW);
      if (libDock) libDock.style.width = libState.width + 'px';
      // 拖拽调宽时页面预留宽度必须同步，否则会露出空白或被盖住
      if (pushActive) libSetPagePush(libState.width);
      if (libPreview && !libPreview.hidden) libPositionPreview();
    }

    function onResizeMove(e: MouseEvent): void {
      if (!libResizing) return;
      e.preventDefault();
      libApplyWidth(libDragStartW + (e.clientX - libDragStartX));
      libExpand();
    }

    function onResizeEnd(): void {
      document.removeEventListener('mousemove', onResizeMove, true);
      document.removeEventListener('mouseup', onResizeEnd, true);
      libResizing = false;
      // 宽度写回 storage，由 background 广播给所有标签页
      void chrome.runtime.sendMessage({
        type: 'LIBRARY_SET_STATE',
        patch: { width: libState.width },
      } satisfies LibrarySetStateMsg);
    }

    // ---------------- 快速预览浮层（画在抽屉 iframe 之外） ----------------
    function libPositionPreview(): void {
      if (!libPreview) return;
      const left = libState.width + 12;
      const h = Math.min(Math.round(window.innerHeight * 0.82), 760);
      const w = Math.max(280, Math.min(640, window.innerWidth - left - 20));
      libPreview.style.left = left + 'px';
      libPreview.style.width = w + 'px';
      libPreview.style.height = h + 'px';
      libPreview.style.top =
        Math.max(
          12,
          Math.min(BAR_H + pvLastY, window.innerHeight - h - 12),
        ) + 'px';
    }

    function libShowPreview(data: ThothPreviewShowMsg): void {
      if (!libPreview) return;
      window.clearTimeout(pvHideTimer);
      window.clearTimeout(hideTimer);
      pvLastY = data.y;
      libExpand();
      libPreview.hidden = false;
      const title = libPreview.querySelector<HTMLElement>('.pv-title');
      if (title) title.textContent = data.title;
      // library 侧只在「条目变化 / 新图片下载完」时传非空 HTML；
      // 这里收到就重建 srcdoc，空串复用已渲染内容，避免重复传输。
      if (data.html) {
        pvCurrentId = data.id;
        const frame = libPreview.querySelector('iframe');
        if (frame) frame.srcdoc = data.html;
      }
      libPositionPreview();
    }

    function libSchedulePreviewHide(): void {
      window.clearTimeout(pvHideTimer);
      pvHideTimer = window.setTimeout(() => {
        if (libPreviewHovering) return;
        if (libPreview) libPreview.hidden = true;
      }, 320);
    }

    function libTeardown(): void {
      window.clearTimeout(hideTimer);
      window.clearTimeout(revealTimer);
      window.clearTimeout(pvHideTimer);
      document.removeEventListener('mousemove', onResizeMove, true);
      document.removeEventListener('mouseup', onResizeEnd, true);
      libRestorePagePush(); // 关闭收藏库必须把页面布局还回去
      libHost?.remove();
      libHost = null;
      libDock = null;
      libFrame = null;
      libPreview = null;
      libPointerInside = false;
      libPreviewHovering = false;
      libResizing = false;
      pvCurrentId = '';
    }

    function libMount(): void {
      if (libHost) return;
      const host = document.createElement('div');
      host.id = 'thoth-library-host';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>
          :host{position:fixed;inset:0;width:0;height:0;pointer-events:none;z-index:2147483645;
            --ground:#080c14;--s1:#0e1521;--s2:#141d2b;--s3:#1b2738;
            --line:rgba(148,180,220,.14);--ink:#e6eefb;--ink-2:#9fb0c9;--ink-3:#7c90ae;
            --accent:#38bdf8;--accent-soft:rgba(56,189,248,.12);--accent-line:rgba(56,189,248,.38);
            --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
            --ui:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
            --ease:cubic-bezier(.22,1,.36,1);}
          *{box-sizing:border-box;}
          /* 停靠式：展开时宿主页面已被挤到右侧，这里只用一条亮边分隔，不再用浮层投影 */
          /* 宽度由 libApplyWidth 按视口上限计算，不用 max-width 再截一次：
             否则页面预留宽度与面板实际宽度会不一致，出现空白缝隙 */
          .dock{position:fixed;left:0;top:0;height:100vh;width:360px;
            display:flex;flex-direction:column;background:var(--s1);color:var(--ink);
            border-right:1px solid var(--accent-line);
            box-shadow:none;pointer-events:auto;
            transform:translateX(calc(-100% + 10px));transition:transform .22s var(--ease);
            font:13px/1.5 var(--ui);}
          .dock[data-expanded="true"],.dock[data-pinned="true"]{transform:translateX(0);}
          /* 右缘亮边：收起时也看得见明确边界，不再与白色网页融合 */
          .edge{position:absolute;right:0;top:0;width:10px;height:100%;
            background:linear-gradient(180deg,var(--accent),rgba(56,189,248,.32));
            cursor:pointer;box-shadow:0 0 12px rgba(56,189,248,.28);}
          .dock[data-expanded="true"] .edge,.dock[data-pinned="true"] .edge{opacity:0;pointer-events:none;}
          .resizer{position:absolute;right:-4px;top:0;width:10px;height:100%;cursor:col-resize;z-index:3;}
          .resizer:hover{background:var(--accent-line);}
          .dock[data-expanded="false"] .resizer{pointer-events:none;}
          .bar{height:34px;flex:0 0 34px;display:flex;align-items:center;gap:7px;padding:0 9px;
            background:var(--ground);border-bottom:1px solid var(--line);}
          .brand{flex:1;min-width:0;display:flex;align-items:center;gap:7px;
            font:11px/1 var(--mono);letter-spacing:.06em;color:var(--ink-3);
            white-space:nowrap;overflow:hidden;}
          .brand b{color:var(--ink);font-weight:600;letter-spacing:.12em;}
          .brand .sep{color:var(--accent);opacity:.75;}
          .pulse{width:6px;height:6px;border-radius:50%;flex:0 0 6px;background:var(--accent);
            box-shadow:0 0 6px var(--accent);animation:thothPulse 2.4s ease-in-out infinite;}
          @keyframes thothPulse{0%,100%{opacity:.35}50%{opacity:1}}
          .bar button{border:1px solid var(--line);border-radius:4px;padding:4px 9px;
            font:11px/1 var(--ui);cursor:pointer;background:var(--s2);color:var(--ink-2);
            transition:border-color .15s ease-out,color .15s ease-out,background .15s ease-out;}
          .bar button:hover{border-color:var(--accent-line);color:var(--ink);background:var(--s3);}
          .bar button:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
          .bar button.on{border-color:var(--accent-line);background:var(--accent-soft);color:var(--accent);}
          .bar button.close:hover{border-color:rgba(251,113,133,.5);color:#fb7185;}
          iframe{flex:1;width:100%;border:0;background:var(--s1);}
          .pv{position:fixed;z-index:2147483647;display:flex;flex-direction:column;
            background:var(--s1);border:1px solid var(--accent-line);border-radius:10px;
            box-shadow:0 16px 48px rgba(0,0,0,.55);pointer-events:auto;overflow:hidden;}
          .pv[hidden]{display:none;}
          .pv-bar{height:34px;flex:0 0 34px;display:flex;align-items:center;gap:8px;padding:0 10px;
            background:var(--ground);border-bottom:1px solid var(--line);}
          .pv-title{flex:1;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;
            white-space:nowrap;color:var(--ink);}
          .pv-badge{flex:0 0 auto;font:10px/1 var(--mono);letter-spacing:.04em;
            color:var(--accent);background:var(--accent-soft);border:1px solid var(--accent-line);
            border-radius:4px;padding:4px 7px;}
          .pv-close{border:1px solid var(--line);border-radius:4px;padding:3px 8px;
            background:var(--s2);color:var(--ink-2);font:13px/1 var(--ui);cursor:pointer;}
          .pv-close:hover{border-color:var(--accent-line);color:var(--ink);}
          /* 内容区保留网页原本底色：白的是快照内容，不是 UI 面板 */
          .pv iframe{flex:1;width:100%;border:0;background:#fff;}
          @media (prefers-reduced-motion:reduce){
            .dock{transition:none;}.pulse{animation:none;opacity:.8;}
            .bar button{transition:none;}
          }
        </style>
        <div class="dock" data-expanded="false" data-pinned="false">
          <div class="bar">
            <span class="brand"><span class="pulse" aria-hidden="true"></span><b>THOTHSYN</b><span class="sep">//</span>LIBRARY</span>
            <button data-act="pin" title="固定为常驻">固定</button>
            <button data-act="close" class="close" title="强制关闭（不再自动出现）" aria-label="强制关闭收藏库">×</button>
          </div>
          <div class="edge" title="展开收藏库"></div>
          <div class="resizer" title="拖动调整宽度"></div>
          <iframe src="${chrome.runtime.getURL('library.html')}" title="Thothsyn 收藏库"></iframe>
        </div>
        <div class="pv" hidden>
          <div class="pv-bar">
            <span class="pv-title" data-no-i18n></span>
            <span class="pv-badge">本地存档 · 离线</span>
            <button class="pv-close" title="关闭预览" aria-label="关闭预览">×</button>
          </div>
          <iframe sandbox="" title="保存的内容"></iframe>
        </div>`;
      applyI18n(root); // 只翻抽屉 shadow DOM 内的文案
      document.documentElement.appendChild(host);
      libHost = host;
      const dock = root.querySelector<HTMLElement>('.dock');
      if (!dock) return;
      libDock = dock;
      libFrame = root.querySelector<HTMLIFrameElement>('.dock iframe');
      const pv = root.querySelector<HTMLElement>('.pv');
      libPreview = pv;

      dock.addEventListener('mouseenter', () => libExpand());
      dock.querySelector('[data-act="close"]')?.addEventListener('click', () => {
        void chrome.runtime.sendMessage({
          type: 'LIBRARY_SET_STATE',
          patch: { open: false, pinned: false },
        } satisfies LibrarySetStateMsg);
      });
      dock.querySelector('[data-act="pin"]')?.addEventListener('click', () => {
        void chrome.runtime.sendMessage({
          type: 'LIBRARY_SET_STATE',
          patch: { pinned: !libState.pinned },
        } satisfies LibrarySetStateMsg);
      });
      dock.querySelector('.edge')?.addEventListener('click', () => libExpand());

      dock.querySelector<HTMLElement>('.resizer')?.addEventListener('mousedown', (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        libResizing = true;
        libDragStartX = e.clientX;
        libDragStartW = libState.width;
        document.addEventListener('mousemove', onResizeMove, true);
        document.addEventListener('mouseup', onResizeEnd, true);
      });

      pv?.addEventListener('mouseenter', () => {
        libPreviewHovering = true;
        window.clearTimeout(pvHideTimer);
        window.clearTimeout(hideTimer); // 看预览时不要把抽屉收起来
      });
      pv?.addEventListener('mouseleave', () => {
        libPreviewHovering = false;
        libSchedulePreviewHide();
      });
      // debug#6：关闭用 pointerdown + click 双保险。
      // pointerdown 在「按下即走」和触控板轻点这类边界场景比 click 稳，
      // 两个都挂是幂等的（关两次没有副作用）。
      const closePreview = (e?: Event) => {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        window.clearTimeout(pvHideTimer);
        libPreviewHovering = false;
        if (pv) pv.hidden = true;
      };
      const pvClose = pv?.querySelector<HTMLElement>('.pv-close');
      pvClose?.addEventListener('pointerdown', closePreview);
      pvClose?.addEventListener('click', closePreview);
      // Esc 也能收掉预览（不影响框选流程：那边自己处理 Esc）
      // 只在第一次挂载时注册一次，避免反复挂载叠加监听器
      if (!pvEscBound) {
        pvEscBound = true;
        window.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key !== 'Escape') return;
          const el = libPreview;
          if (!el || el.hidden) return;
          el.hidden = true;
          libPreviewHovering = false;
        });
      }
    }

    function libSync(state: LibraryState, reveal = false): void {
      libState = state;
      if (!state.open) {
        libTeardown();
        return;
      }
      libMount();
      if (!libDock) return;
      libApplyWidth(state.width);
      libDock.dataset.pinned = String(state.pinned);
      const pinBtn =
        libDock.querySelector<HTMLButtonElement>('[data-act="pin"]');
      if (pinBtn) {
        pinBtn.classList.toggle('on', state.pinned);
        pinBtn.textContent = state.pinned ? t('取消固定') : t('固定');
      }
      if (state.pinned) libExpand();
      else if (reveal) libReveal();
      else if (!libPointerInside && !libPreviewHovering) libCollapse();
    }

    function libOnMouseMove(e: MouseEvent): void {
      if (!libState.open || libState.pinned || libResizing) return;
      if (libPreviewHovering) {
        window.clearTimeout(hideTimer);
        return;
      }
      const x = e.clientX;
      if (x <= LIB_HOT) {
        libPointerInside = true;
        libExpand();
      } else if (x > libState.width + 12) {
        libPointerInside = false;
        libScheduleCollapse();
      } else {
        libPointerInside = true;
        window.clearTimeout(hideTimer);
      }
      // 鼠标进入 iframe 后父文档不再收到 mousemove，
      // libPointerInside 保持 true，因此面板不会在浏览收藏时误收起。
    }

    document.addEventListener('mousemove', libOnMouseMove, true);
    // 视口变窄后重新夹紧抽屉宽度，避免预留宽度超出可视区域
    window.addEventListener('resize', () => {
      if (!libState.open) return;
      libApplyWidth(libState.width);
      if (libPreview && !libPreview.hidden) libPositionPreview();
    });

    // 只接受收藏库 iframe 发来的预览消息（校验 origin 与 source），
    // 网页自身伪造的消息会被丢弃。
    const extOrigin = new URL(chrome.runtime.getURL('library.html')).origin;
    window.addEventListener('message', (e: MessageEvent) => {
      if (e.origin !== extOrigin) return;
      if (!libFrame || e.source !== libFrame.contentWindow) return;
      const data = e.data as ThothPreviewMsg | undefined;
      if (!data || data.source !== 'thothsyn-library') return;
      if (data.type === 'THOTH_PREVIEW_SHOW') libShowPreview(data);
      else if (data.type === 'THOTH_PREVIEW_HIDE') libSchedulePreviewHide();
    });

    // 页面初始化拉取持久状态：用户没点过 × 就一直保持自动隐藏模式
    void Promise.resolve(
      chrome.runtime.sendMessage({ type: 'LIBRARY_GET_STATE' }) as Promise<
        LibraryState | undefined
      >,
    )
      .then((s) =>
        libSync(s ?? { open: false, pinned: false, width: 360 }),
      )
      .catch(() => {});

    // ---- 工具栏图标闪烁（debug#6） ----
    // Chrome 官方：action.setIcon 只用于静态图片，不支持动画图片；
    // MV3 Service Worker 空闲约 30s 被回收、chrome.alarms 最小周期 30s，
    // 因此不能靠后台定时器做快速闪烁。改由**可见标签页**发心跳，
    // 后台收到后交替 setIcon 两帧静态 PNG；隐藏标签页不发送，避免并发唤醒。
    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    let iconTimer = 0;
    function startIconHeartbeat(): void {
      if (iconTimer || reducedMotion) return;
      iconTimer = window.setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        void Promise.resolve(
          chrome.runtime.sendMessage({ type: 'ICON_TICK' }),
        ).catch(() => {});
      }, 900);
    }
    function stopIconHeartbeat(): void {
      if (!iconTimer) return;
      window.clearInterval(iconTimer);
      iconTimer = 0;
    }
    void Promise.resolve(
      chrome.runtime.sendMessage({ type: 'ICON_GET_STATE' }) as Promise<
        { blink?: boolean } | undefined
      >,
    )
      .then((s) => {
        if (s?.blink) startIconHeartbeat();
      })
      .catch(() => {});

    // ---- 消息路由 ----
    chrome.runtime.onMessage.addListener(
      (msg: IncomingMsg, _sender, sendResponse) => {
        if (msg?.type === 'THOTH_PING') {
          sendResponse(true);
          return true;
        }
        if (msg?.type === 'CAPTURE_FULL') {
          sendResponse(captureFull());
          return true;
        }
        if (msg?.type === 'START_PARTIAL_SELECT') {
          startPartialSelect();
        }
        if (msg?.type === 'LIBRARY_STATE') {
          libSync(msg.state, msg.reveal === true);
        }
        if (msg?.type === 'ICON_BLINK_STATE') {
          if (msg.blink) startIconHeartbeat();
          else stopIconHeartbeat();
        }
      },
    );

    void ctx;
  },
});
