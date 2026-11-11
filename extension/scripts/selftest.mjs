/**
 * Thothsyn 0.1.4 函数级回归测试（无浏览器依赖）。
 * 直接用 TypeScript 转译加载真实 .ts 模块，配合 linkedom 的 DOMParser。
 *
 * 运行：node scripts/selftest.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// 让 Node 直接 require 项目里的 .ts 源文件
Module._extensions['.ts'] = (m, filename) => {
  const src = fs.readFileSync(filename, 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  m._compile(js, filename);
};

global.DOMParser = require('linkedom').DOMParser;

// 最小 chrome.storage.local 模拟
const store = new Map();
global.chrome = {
  storage: {
    local: {
      async get(key) {
        return typeof key === 'string'
          ? { [key]: store.get(key) }
          : Object.fromEntries(
              [...store].filter(([k]) => (key ?? []).includes(k)),
            );
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) store.set(k, v);
      },
    },
    onChanged: { addListener() {} },
  },
};

const A = require(path.join(ROOT, 'src/lib/assets.ts'));
const O = require(path.join(ROOT, 'src/lib/offline.ts'));
const S = require(path.join(ROOT, 'src/lib/settings.ts'));

let failed = 0;
function check(name, ok, extra = '') {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${extra ? ' :: ' + extra : ''}`);
}

async function main() {
  console.log('=== 1. debug#4：快照资源提取（图片 / 外链 CSS / 脚本） ===');
  const snap = `<html><head>
    <link rel="stylesheet" href="/styles/main.css">
    <link rel="preload" as="style" href="/skip.css">
    <script src="/app.js"></script>
    <script src="https://cdn.example.com/analytics.js"></script>
    </head><body>
    <img src="/a.png"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
    <div style="background-image:url(/e.png)"></div>
    </body></html>`;
  const res = A.extractResourceUrls(snap, 'https://news.example.com/post/1');
  check(
    '只收 rel=stylesheet，不收 preload',
    res.styles.length === 1 &&
      res.styles[0] === 'https://news.example.com/styles/main.css',
    JSON.stringify(res.styles),
  );
  check(
    '两个 script src 都绝对化',
    res.scripts.length === 2 &&
      res.scripts.includes('https://news.example.com/app.js') &&
      res.scripts.includes('https://cdn.example.com/analytics.js'),
    JSON.stringify(res.scripts),
  );
  check(
    '图片排除 data: 且相对路径绝对化',
    res.images.includes('https://news.example.com/a.png') &&
      res.images.includes('https://news.example.com/e.png') &&
      !res.images.some((u) => u.startsWith('data:')),
    JSON.stringify(res.images),
  );

  console.log('\n=== 2. debug#4：CSS 内 url() 按样式表自身 URL 解析 ===');
  const css = '@import url(other.css); .x{background:url(../img/bg.png)} @font-face{src:url(/fonts/x.woff2)}';
  const refs = A.extractCssUrls(css, 'https://cdn.example.com/css/site.css');
  check(
    '图片相对 CSS 解析',
    refs.images.length === 1 &&
      refs.images[0] === 'https://cdn.example.com/img/bg.png',
    JSON.stringify(refs.images),
  );
  check(
    '字体被单独识别',
    refs.fonts.length === 1 &&
      refs.fonts[0] === 'https://cdn.example.com/fonts/x.woff2',
    JSON.stringify(refs.fonts),
  );

  const dataPng = 'data:image/png;base64,AQID';
  const dataFont = 'data:font/woff2;base64,QUJD';
  const local = new Map([
    ['https://cdn.example.com/img/bg.png', dataPng],
    ['https://cdn.example.com/fonts/x.woff2', dataFont],
  ]);
  const rewritten = O.rewriteCss(css, 'https://cdn.example.com/css/site.css', local);
  check('CSS url() 换成本地 data:', rewritten.includes(`url(${dataPng})`) && rewritten.includes(`url(${dataFont})`));
  check('@import 被剔除（CSP 下无意义）', !rewritten.includes('@import'));

  console.log('\n=== 2b. debug#5：内联 CSS 字体按 font 分流，不再误当图片 ===');
  const inlineCssSnap = `<html><head><style>
    @font-face{src:url(https://cdn.example.com/f.woff2) format('woff2')}
    .x{background:url(/p.png)}
  </style></head><body></body></html>`;
  const split = A.extractResourceUrls(inlineCssSnap, 'https://example.com/post');
  check('字体单独进 fonts 列表', split.fonts.includes('https://cdn.example.com/f.woff2'), JSON.stringify(split.fonts));
  check('字体不再混进图片候选（否则下载必失败）', !split.images.some((u) => /\.woff2/i.test(u)), JSON.stringify(split.images));
  check('内联 CSS 的图片仍正常入队', split.images.includes('https://example.com/p.png'));

  console.log('\n=== 3. debug#4：离线 HTML 内联 CSS + 安全规则 ===');
  const out = O.offlineHtml(
    '<html><head><link rel="stylesheet" href="/styles/main.css"><title>t</title></head>' +
      '<body><img src="/a.png"><img src="/missing.jpg">' +
      '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><script>alert(1)</script>' +
      '<div style="background-image:url(/e.png)">x</div></body></html>',
    'https://news.example.com/post/1',
    new Map([
      ['https://news.example.com/a.png', dataPng],
      ['https://news.example.com/e.png', dataPng],
    ]),
    rewritten,
  );
  check('CSP 仍在 head 开头且 default-src none', /<head><meta http-equiv="Content-Security-Policy"/.test(out) && out.includes("default-src 'none'"));
  check('外链 <link rel=stylesheet> 被移除', !out.includes('main.css'));
  check('本地 CSS 作为 <style> 内联', out.includes('data-thoth="offline-css"') && out.includes(dataPng));
  check('script 被剔除、绝不注入', !out.includes('alert(1)'));
  check('已下载图片变 data: URL', out.includes(`src="${dataPng}"`));
  check('未下载的相对外链 src 被移除', !out.includes('missing.jpg'));
  check('原本内联的 data: 图片保留', out.includes('data:image/gif;base64'));

  // ---------------------------------------------------------------------
  // 0.1.5 debug#5：真实站点（百度移动版）快照的清洗回归。
  // 复现用户报错：原页面 CSP / meta refresh / 内联事件 / 未本地化的字体
  // url() 被留在 srcdoc 里，触发成百上千条 CSP 拒绝并拖慢预览。
  // ---------------------------------------------------------------------
  console.log('\n=== 3b. debug#5：预览彻底离线化（不得残留任何外链或可执行内容） ===');
  const hostile = `<!doctype html><html><head>
    <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'wasm-unsafe-eval' 'inline-speculation-rules'">
    <meta http-equiv="refresh" content="0;url=https://m.baidu.com/from">
    <link rel="stylesheet" href="/se/static/css/site.css">
    <style>
      @font-face{font-family:icon;src:url(https://pss.bdstatic.com/iconfont.woff2) format('woff2'),url(https://pss.bdstatic.com/iconfont.woff) format('woff')}
      .bg{background-image:url(https://pss.bdstatic.com/bg.png)}
    </style>
    </head><body>
    <a href="javascript:go()" onclick="go()">click</a>
    <div onmouseover="hint()" style="background:url(/local-bg.png)">text</div>
    <SCRIPT type="text/javascript">var x=1;</SCRIPT>
    <iframe src="https://ads.example.com/a"></iframe>
    <video poster="https://cdn.example.com/poster.jpg" data-src="https://cdn.example.com/lazy.jpg"></video>
    <img src="/ok.png">
    </body></html>`;
  const okPng = 'data:image/png;base64,T0s=';
  const hostileOut = O.offlineHtml(
    hostile,
    'https://m.baidu.com/s?wd=x',
    new Map([['https://m.baidu.com/ok.png', okPng]]),
    '@font-face{font-family:remote;src:url(https://m.baidu.com/se/static/font/cicon.woff)}',
  );
  const cspCount = (hostileOut.match(/Content-Security-Policy/gi) || []).length;
  check('原页面自带 CSP 被移除，只保留注入的一条', cspCount === 1 && !hostileOut.includes('wasm-unsafe-eval'), `count=${cspCount}`);
  check('<meta http-equiv=refresh> 被移除', !/http-equiv=["']?refresh/i.test(hostileOut));
  check('内联事件属性 on* 被剥离', !/\son(?:click|mouseover|load|error)\s*=/i.test(hostileOut));
  check('javascript: 链接被剥离', !/javascript:/i.test(hostileOut));
  check('所有 <script>（含大写）被剔除', !/<script\b/i.test(hostileOut));
  check('iframe / object / embed 被剔除', !/<(?:iframe|object|embed)\b/i.test(hostileOut));
  check('CSS 里未本地化的绝对 URL 不残留', !/url\(\s*["']?https?:/i.test(hostileOut), hostileOut.slice(0, 0));
  check('字体 CDN 域名彻底消失', !hostileOut.includes('pss.bdstatic.com') && !hostileOut.includes('m.baidu.com/se/static/font'));
  check('poster / 懒加载 data-* 不留外链', !hostileOut.includes('cdn.example.com'));
  check('未命中的 @font-face 规则被删除（不发字体请求）', !/@font-face/i.test(hostileOut));
  check('已下载图片仍换成 data: URL', hostileOut.includes(`src="${okPng}"`));
  check('注入的 CSP 仍是 default-src none', hostileOut.includes("default-src 'none'"));

  console.log('\n=== 3c. debug#5：未命中 url() 的安全占位 ===');
  const missCss = '.a{background:url(https://cdn.example.com/miss.png)} .b{background:url(/ok.png)}';
  const missOut = O.rewriteCss(missCss, 'https://example.com/p', new Map([['https://example.com/ok.png', okPng]]));
  check('命中项换成本地 data:', missOut.includes(`url(${okPng})`));
  check('未命中项不再留绝对 URL', !/url\(\s*["']?https?:/i.test(missOut), missOut);

  // ---------------------------------------------------------------------
  // debug#4（0.1.6）：用户控制台仍刷 "Executing inline event handler
  // violates ... 'script-src 'self''"。srcdoc iframe 继承父文档 CSP，
  // 只要快照里残留任意一个 on* 属性，浏览器就会为每个属性打一条违规日志。
  // 0.1.5 的用例只查了 click/mouseover/load/error 四个名字，且没测
  // <html> 根元素（querySelectorAll('*') 不含 documentElement）与 <template>
  // （内容在 content fragment，遍历不到）。这里按「任意 on* 清零」复现。
  // ---------------------------------------------------------------------
  console.log('\n=== 3d. debug#4：srcdoc 开标签内 0 个 inline event handler ===');
  const hostile2 = `<!doctype html><html lang="zh" onload="boot()" onpageshow="boot2()">
<head><meta http-equiv="refresh" content="0;url=https://evil.example.com"></head>
<body onfocus="f()" onpointerdown="p()">
  <div onwheel="w()" ontoggle="t()" onanimationend="a()">ok</div>
  <template><img src="x" onerror="boom()"></template>
  <svg onload="s()"></svg>
  <iframe srcdoc="<img src=x onerror=boom()>"></iframe>
  <a href="JaVaScRiPt:evil()" formaction="javascript:go()">link</a>
  <input oninvalid="i()">
  <p>正文里出现 onclick="text()" 只是文本</p>
</body></html>`;
  const out2 = O.offlineHtml(hostile2, 'https://example.com/p', new Map());
  const openTags2 = [...out2.matchAll(/<[a-zA-Z][^>]*>/g)].map((m) => m[0]).join('\n');
  check('documentElement 上的 onload/onpageshow 被剥离', !/\son(?:load|pageshow)\s*=/i.test(out2));
  check('开标签内任意 on* 事件属性清零（含 pointer/wheel/toggle 等新事件名）', !/\son[a-z0-9_-]+\s*=/i.test(openTags2), openTags2);
  check('template 内的 onerror 也被剥离', !/onerror/i.test(out2));
  check('javascript: 大小写混合也被剥离', !/javascript:/i.test(out2));
  check('srcdoc 属性被剥离', !/srcdoc\s*=/i.test(out2));
  check('iframe 被剥离', !/<iframe\b/i.test(out2));
  check('refresh meta 被剥离', !/http-equiv=["']?refresh/i.test(out2));
  check('正文文本仍在（清洗没有把内容一起吃掉）', out2.includes('ok') && out2.includes('link'));
  check('注入的 CSP 仍只有一条', (out2.match(/Content-Security-Policy/gi) || []).length === 1);

  // ---------------------------------------------------------------------
  // debug#4（0.1.7）：真实 Chrome 探针证实，扩展页 CSP 下
  // `new DOMParser().parseFromString(原始快照)` 本身就会为每个 on* 属性打一条
  // "Executing inline event handler violates ... 'script-src 'self' ...'"。
  // 0.1.6 的清洗发生在**序列化之后**，日志在解析阶段已经刷完，所以用户
  // 控制台仍然刷屏。这里用 spy 断言交给 DOMParser 的字符串本身是干净的。
  // ---------------------------------------------------------------------
  console.log('\n=== 3e. debug#4：交给 DOMParser 的字符串必须先清洗 ===');
  const LinkedomParser = require('linkedom').DOMParser;
  let parsedByDom = '';
  global.DOMParser = class {
    parseFromString(s, t) {
      parsedByDom = s;
      return new LinkedomParser().parseFromString(s, t);
    }
  };
  try {
    const dirtyParse = `<!doctype html><html onload="a()"><body onfocus="b()">
      <img src="x" onerror="c()"><div onmouseover="d()">t</div>
      <img src="x"onerror="nospace()"><div title="a>b" onwheel="w()">q</div>
      <template><img onerror="e()"></template><svg onload="f()"></svg>
      <a href="JaVaScRiPt:go()" onclick="g()">link</a>
      <iframe srcdoc="<img onerror=h()>"></iframe>
      <script>var q=1;</script></body></html>`;
    O.offlineHtml(dirtyParse, 'https://example.com/p', new Map());
    const tags = [...parsedByDom.matchAll(/<[a-zA-Z][^>]*>/g)]
      .map((m) => m[0])
      .join('\n');
    check(
      '解析前字符串里 0 个 on* 事件属性（CSP 违规的真实触发点）',
      !/\son[a-z0-9_-]+\s*=/i.test(tags),
      tags.slice(0, 240),
    );
    check(
      '解析前不含 srcdoc / javascript: / script 标签',
      !/\ssrcdoc\s*=/i.test(parsedByDom) &&
        !/javascript:/i.test(parsedByDom) &&
        !/<script\b/i.test(parsedByDom),
    );
    check('解析前仍保留正文内容', parsedByDom.includes('link') && parsedByDom.includes('>t<'));
  } finally {
    global.DOMParser = LinkedomParser;
  }

  console.log('\n=== 4. debug#3：删除确认开关两条分支 ===');
  check('undefined → 不需要确认', S.needsDeleteConfirm(undefined) === false);
  check('false → 不需要确认', S.needsDeleteConfirm(false) === false);
  check('true → 需要确认', S.needsDeleteConfirm(true) === true);
  check('字符串 "true" 不被误判', S.needsDeleteConfirm('true') === false);
  check('默认读取（无存储值）→ false', (await S.getBool(S.DELETE_CONFIRM_KEY, false)) === false);
  await S.setBool(S.DELETE_CONFIRM_KEY, true);
  check('开启后读回 → true（生效）', (await S.getBool(S.DELETE_CONFIRM_KEY, false)) === true);
  await S.setBool(S.DELETE_CONFIRM_KEY, false);
  check('关闭后读回 → false（生效）', (await S.getBool(S.DELETE_CONFIRM_KEY, false)) === false);

  console.log('\n=== 5. debug#2：数据版本号每次写入都变化 ===');
  await S.bumpRevision();
  const r1 = store.get(S.REVISION_KEY);
  await S.bumpRevision();
  const r2 = store.get(S.REVISION_KEY);
  check('连续两次 bump 产生不同值', typeof r1 === 'string' && r1 !== r2, `${r1} / ${r2}`);

  console.log('\n=== 6. 产物静态核对 ===');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, '.output/chrome-mv3/manifest.json'), 'utf8'),
  );
  // 版本由 package.json 与 wxt.config.ts 同步维护，这里不写死具体数值，
  // 否则每次升小版本都要再改一次自检脚本。
  check(
    'manifest 版本与 package.json 一致且格式合法',
    /^\d+\.\d+\.\d+$/.test(manifest.version) &&
      manifest.version ===
        JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
          .version,
    manifest.version,
  );
  check('options_ui.open_in_tab = true', manifest.options_ui?.open_in_tab === true);
  check('action.default_icon 指向存在的 PNG', Object.values(manifest.action?.default_icon ?? {}).every((p) => fs.existsSync(path.join(ROOT, '.output/chrome-mv3', p))));
  const a16 = fs.readFileSync(path.join(ROOT, 'public/icon/a/16.png'));
  const b16 = fs.readFileSync(path.join(ROOT, 'public/icon/b/16.png'));
  check('两帧图标字节不同（确实会闪）', !a16.equals(b16));

  const readAll = (globPrefix) => {
    const dir = path.join(ROOT, '.output/chrome-mv3');
    const files = fs.readdirSync(dir, { recursive: true }).filter((f) => typeof f === 'string');
    let text = '';
    for (const f of files) {
      if (!/\.(js|css|html)$/.test(f)) continue;
      if (globPrefix && !f.includes(globPrefix)) continue;
      text += fs.readFileSync(path.join(dir, f), 'utf8');
    }
    return text;
  };
  const jsAll = readAll();
  const markers = [
    'ICON_TICK',
    'ICON_BLINK_STATE',
    'thothRevision',
    'thothDeleteConfirm',
    'it-del',
    'settings-entry',
    'offline-css',
    'assetsBackfill.0.1.5',
    'open_in_tab',
    // 用「压缩后仍稳定存在」的字面量，而不是会被 esbuild 改名的函数名
    '导入完成：新增',
    'id="toast"',
    'grid-template-rows',
    'meta[http-equiv]',
    'R0lGODlhAQABAIAAAAAAAP',
    '未分类',
    // 0.1.7：压缩后仍稳定存在的字面量
    'standalone-preview',
    'body.standalone',
    'margin-left',
    'calc(100% - ',
    'badge readme',
    '^(https?|file):',
  ];
  for (const k of markers) check(`产物含 ${k}`, jsAll.includes(k) || (k === 'open_in_tab' && manifest.options_ui?.open_in_tab === true));
  check('收藏库产物不再含导入模态', !jsAll.includes('openImportModal'));
  check('脚本只存档、没有把 <script> 注入预览', !jsAll.includes('data-thoth="offline-js"'));

  console.log('\n=== 7. 0.1.5 五条反馈的源文件核对（不依赖构建压缩） ===');
  const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const libCss = src('src/entrypoints/library/library.css');
  check('debug#1：网格行高被锁定', /grid-template-rows:\s*minmax\(0,\s*1fr\)/.test(libCss) && libCss.includes('overflow: hidden'));
  check('debug#1：.main 与 .list 都有 min-height:0', /\.main\s*\{[^}]*min-height:\s*0/.test(libCss) && /\.list\s*\{[^}]*min-height:\s*0/.test(libCss));
  check('debug#1：设置入口是 flex 固定底栏', /\.tree-foot\s*\{[^}]*flex:\s*0 0 auto/.test(libCss));
  check('debug#2：设置页有独立 toast 容器', src('src/entrypoints/options/index.html').includes('id="toast"'));
  check('debug#2：导入成功/失败/空结果都有提示', (() => { const t = src('src/entrypoints/options/main.ts'); return t.includes('导入完成：新增') && t.includes('导入完成：书签栏里没有') && t.includes('导入失败：'); })());
  const seed = src('src/lib/seed.ts');
  check('debug#3：默认分类已改为未分类', seed.includes("DEFAULT_FOLDER_NAME = '未分类'"));
  check('debug#3：历史「等待阅读」原地迁移', seed.includes("'等待阅读'") && seed.includes('patchFolder(legacy.id'));
  check('debug#3：新收藏取默认业务文件夹', src('src/entrypoints/background.ts').includes('defaultBusinessFolder()'));
  const imp = src('src/lib/import.ts');
  check('debug#4：顶层书签栏映射为业务文件夹', imp.includes("ensureFolder(root, 'business'") && imp.includes("ensureFolder(p, 'tag'"));
  check('debug#4：重复导入复用同名文件夹', imp.includes('db.folders.where(\'type\')'));
  const off = src('src/lib/offline.ts');
  check('debug#5：未命中 url() 用空 data: 占位', off.includes('EMPTY_IMAGE_DATA_URL'));
  check('debug#5：剥离原 CSP / refresh / 内联事件', off.includes("meta[http-equiv]") && off.includes('/^on/'));
  check('debug#5：预览有缓存与失效入口', off.includes('htmlCache') && off.includes('invalidateOfflineCache'));

  // ---------------------------------------------------------------------
  // 0.1.6：四条 debug 反馈的回归基线
  // ---------------------------------------------------------------------
  console.log('\n=== 8. 0.1.6：多语言 / 图标 / readme / CSP 清洗 ===');
  const I = require(path.join(ROOT, 'src/lib/i18n.ts'));
  const R = require(path.join(ROOT, 'src/lib/readme.ts'));

  // 8a. chrome.i18n 缺席时退回中文（函数级测试环境），有则跟随浏览器语言
  check('t() 无 chrome.i18n 时退回中文并替换占位符', I.t('已选 $1 个', 3) === '已选 3 个');
  check('t() 未登记的文案原样返回', I.t('这段文案没登记') === '这段文案没登记');
  check('folderLabel() 用户自建文件夹不翻译', I.folderLabel('我的收藏夹') === '我的收藏夹');
  check('folderLabel() 种子文件夹名走语言包', I.folderLabel('未分类') === '未分类');

  const zhMessages = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'public/_locales/zh_CN/messages.json'), 'utf8'),
  );
  const enMessages = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'public/_locales/en/messages.json'), 'utf8'),
  );
  const zhKeySet = Object.keys(zhMessages).sort().join(',');
  const enKeySet = Object.keys(enMessages).sort().join(',');
  check('zh_CN / en 两套 locale 的 key 完全一致', zhKeySet === enKeySet, `${Object.keys(zhMessages).length} keys`);
  check('每条 message 都非空', Object.values(zhMessages).every((e) => e.message.length > 0) && Object.values(enMessages).every((e) => e.message.length > 0));
  check('带占位符的条目前后数量一致', Object.keys(zhMessages).every((k) => {
    const a = (zhMessages[k].message.match(/\$\d/g) ?? []).sort().join(',');
    const b = (enMessages[k].message.match(/\$\d/g) ?? []).sort().join(',');
    return a === b;
  }));

  global.chrome.i18n = {
    getMessage(key, subs = []) {
      const raw = enMessages[key]?.message;
      if (!raw) return '';
      return subs.reduce((s, v, i) => s.split(`$${i + 1}`).join(String(v)), raw);
    },
    getUILanguage: () => 'en-US',
  };
  check('浏览器语言 en-US → 菜单译英文', I.t('保存整页') === 'Save full page');
  check('浏览器语言 en-US → 带占位符的文案译英文', I.t('已选 $1 个', 3) === '3 selected');
  check('浏览器语言 en-US → 默认分类名译英文', I.folderLabel('未分类') === 'Uncategorized');
  check('uiLanguage() 返回浏览器 UI 语言', I.uiLanguage() === 'en-US');
  delete global.chrome.i18n;

  const zhTexts = new Set(Object.values(zhMessages).map((v) => v.message));
  const i18nSources = [
    'src/entrypoints/library/main.ts',
    'src/entrypoints/options/main.ts',
    'src/entrypoints/content.ts',
    'src/entrypoints/reader/main.ts',
    'src/entrypoints/background.ts',
  ];
  const tArgs = [];
  for (const p of i18nSources) {
    const text = fs.readFileSync(path.join(ROOT, p), 'utf8');
    for (const m of text.matchAll(/\bt\(\s*'([^']+)'/g)) tArgs.push(m[1]);
  }
  check(`t() 的 ${tArgs.length} 个中文参数全部登记在语言包中`, tArgs.every((v) => zhTexts.has(v)), tArgs.filter((v) => !zhTexts.has(v)).join(' | '));
  check('manifest 用 __MSG__ 占位且声明 default_locale', manifest.name === '__MSG_extName__' && manifest.default_locale === 'en');
  check('产物包含两套 _locales/messages.json', fs.existsSync(path.join(ROOT, '.output/chrome-mv3/_locales/zh_CN/messages.json')) && fs.existsSync(path.join(ROOT, '.output/chrome-mv3/_locales/en/messages.json')));

  // 8b. 图标：来自 docs/icons 的两张原图，四尺寸两帧
  const iconSources = [
    path.resolve(ROOT, '../docs/icons/icon1.png'),
    path.resolve(ROOT, '../docs/icons/icon2.png'),
  ];
  check('docs/icons 两张原图存在', iconSources.every((p) => fs.existsSync(p)));
  check('新生成器引用了这两张原图', (() => { const g = fs.readFileSync(path.join(ROOT, 'scripts/gen-icons.py'), 'utf8'); return g.includes('icon1.png') && g.includes('icon2.png') && g.includes('LANCZOS'); })());
  check('旧的程序化图标生成器已移除', !fs.existsSync(path.join(ROOT, 'scripts/gen-icons.mjs')));
  const iconSizes = [16, 32, 48, 128];
  for (const frame of ['a', 'b']) {
    for (const n of iconSizes) {
      const buf = fs.readFileSync(path.join(ROOT, `public/icon/${frame}/${n}.png`));
      check(`图标 ${frame}/${n}.png 是 ${n}x${n} PNG`, buf.subarray(1, 4).toString() === 'PNG' && buf.readUInt32BE(16) === n && buf.readUInt32BE(20) === n);
    }
  }
  check('两帧 16px 图标字节不同（确实会闪）', !fs.readFileSync(path.join(ROOT, 'public/icon/a/16.png')).equals(fs.readFileSync(path.join(ROOT, 'public/icon/b/16.png'))));

  // 8c. readme 收藏：内容来自 docs/readme.md，渲染安全，安装/升级均补
  const docsReadme = fs.readFileSync(path.resolve(ROOT, '../docs/readme.md'), 'utf8');
  const readmeConst = require(path.join(ROOT, 'src/lib/readme-content.ts')).README_MARKDOWN;
  check('编译期 readme 常量与 docs/readme.md 完全一致', readmeConst === docsReadme);
  const readmeHtml = R.readmeSourceToHtml('# 标题\n\n- 列表项 `code`\n\n普通段落');
  check('readme 渲染出标题 / 列表 / 行内代码', readmeHtml.includes('<h2>标题</h2>') && readmeHtml.includes('<li>列表项 <code>code</code></li>'));
  check('readme 渲染转义 HTML（不可信文本不进 DOM）', !R.readmeSourceToHtml('<img src=x onerror=alert(1)>').includes('<img'));
  check('readme 快照里没有任何 on* 属性', !/\son[a-z0-9_-]+\s*=/i.test(R.readmeHtml()));
  const bg = fs.readFileSync(path.join(ROOT, 'src/entrypoints/background.ts'), 'utf8');
  check('安装与升级都会补 readme 收藏', (bg.match(/ensureReadmeCapture\(\)/g) ?? []).length >= 2 && bg.includes('onInstalled'));
  const libMain = fs.readFileSync(path.join(ROOT, 'src/entrypoints/library/main.ts'), 'utf8');
  check('readme 收藏点击打开本地 reader', libMain.includes('README_ID') && libMain.includes('reader.html?id='));

  // 8d. CSP 清洗：DOM 层递归 + 序列化后字符串兜底
  check('offline.ts 有序列化兜底与 template 递归', off.includes('scrubSerializedAttributes') && off.includes("querySelectorAll('template')"));
  check('offline.ts 仍在 srcdoc 注入 default-src none', off.includes("default-src 'none'"));

  // ---------------------------------------------------------------------
  // 0.1.7：四条 debug 反馈的回归基线
  // ---------------------------------------------------------------------
  console.log('\n=== 9. 0.1.7：停靠侧栏 / 兜底侧栏 / readme 强调 / CSP 根因 ===');
  const ct = src('src/entrypoints/content.ts');
  const libHtml = src('src/entrypoints/library/index.html');

  check(
    'debug#2：展开时给宿主 html 预留左侧宽度并收窄页面',
    ct.includes("key === 'margin-left'") &&
      ct.includes('calc(100% - ') &&
      ct.includes('libEnsurePushBase') &&
      ct.includes("'important'"),
  );
  check(
    'debug#2：收起与关闭精确还原页面原始内联样式',
    ct.includes('libSetPagePush(null)') &&
      ct.includes('libRestorePagePush()') &&
      ct.includes('getPropertyPriority'),
  );
  check(
    'debug#2：拖拽调宽与窗口 resize 都同步预留宽度',
    ct.includes('if (pushActive) libSetPagePush(libState.width)') &&
      ct.includes("addEventListener('resize'"),
  );
  check(
    'debug#2：停靠态不再用浮层投影，也不二次截宽',
    ct.includes('box-shadow:none') && !ct.includes('max-width:86vw'),
  );
  check(
    'debug#2：整页快照剥掉停靠内联样式与插件自身 UI 节点',
    ct.includes('cloneNode(true)') &&
      ct.includes('pushOriginal[key]') &&
      ct.includes('#thoth-library-host'),
  );

  check(
    'debug#1：兜底标签页有侧栏提示与独立预览浮层',
    libHtml.includes('id="standalone-hint"') &&
      libHtml.includes('id="standalone-preview"'),
  );
  check(
    'debug#1：顶层窗口收敛为 360px 左栏而不是铺满整页',
    libMain.includes('window.top === window.self') &&
      libCss.includes('body.standalone #app') &&
      libCss.includes('min(360px, 100vw)'),
  );
  check(
    'debug#1：兜底页自己接收预览消息（校验 source）',
    libMain.includes('standalonePreview.hidden = false') &&
      libMain.includes('e.source !== window'),
  );
  check(
    'debug#1：background 复用兜底标签页',
    bg.includes('libraryTabId') && bg.includes('chrome.tabs.update'),
  );

  check(
    'debug#3：readme 加粗加红 + 徽标',
    libMain.includes("' readme'") &&
      libMain.includes('badge readme') &&
      libCss.includes('.item.readme .it-title') &&
      libCss.includes('font-weight: 700') &&
      libCss.includes('#ff8da1'),
  );

  check(
    'debug#4a：注入前按 URL 预检，chrome:// 静默走兜底',
    bg.includes('isInjectableUrl') &&
      bg.includes('chrome.tabs.get(tabId)') &&
      bg.includes('if (!isInjectableUrl(tab.url)) return false;'),
  );
  check(
    'debug#4b：DOMParser 拿到的是先清洗过的字符串（真实根因）',
    /scrubSerializedAttributes\(withoutLinks\)[\s\S]{0,240}parseFromString\(safeHtml/.test(off),
  );
  check(
    'debug#4b：导入 HTML 解析前同样清洗',
    imp.includes('scrubSerializedAttributes(text)'),
  );
  check(
    'debug#4b：字符串层兼容无空格分隔的属性',
    off.includes('\\s*([^\\s=/>]+)'),
  );

  console.log('\n=== 10. 0.1.8：云同步客户端 / 墓碑 / 定时同步 ===');
  const syn = src('src/lib/sync.ts');
  const repo = src('src/lib/repo.ts');
  const dbSrc = src('src/db/database.ts');
  const optMain = src('src/entrypoints/options/main.ts');

  check(
    '上行：整页收藏只传链接，不传 html/text',
    syn.includes("html: full ? '' : c.html") && syn.includes("text: full ? '' : c.text"),
  );
  check(
    '下行：不覆盖本地已有快照',
    syn.includes('String(rec.html') && syn.includes('|| local?.html'),
  );
  check(
    '下行：本地更新更晚时不被旧云端记录覆盖',
    syn.includes('incomingUpdated < local.updatedAt'),
  );
  check(
    '删除：本地真删 + 墓碑，同步上下行都不回声',
    repo.includes('db.tombstones.put') &&
      repo.includes('export async function purgeCapture') &&
      src('src/entrypoints/library/main.ts').includes('removeCaptureRecord(id)'),
  );
  check(
    '所有本地写都打 updatedAt（写入口收敛到 repo）',
    repo.includes('updatedAt: nowMs()') &&
      !/(db\.captures\.(add|put|update|delete|bulkAdd|bulkPut)|db\.folders\.(add|put|update|delete|bulkAdd|bulkPut))/.test(
        bg + optMain + imp + seed + src('src/entrypoints/library/main.ts') + src('src/lib/readme.ts'),
      ),
  );
  check(
    'DB v3：墓碑表 + updatedAt 索引 + 老记录补时间戳',
    dbSrc.includes('tombstones: \'id, entity, updatedAt\'') &&
      dbSrc.includes('*tags, updatedAt') &&
      dbSrc.includes('if (!c.updatedAt)') &&
      dbSrc.includes('if (!f.updatedAt)'),
  );
  check(
    '未验证邮箱不允许同步',
    syn.includes("session.level === 'unverified'"),
  );
  check(
    '令牌过期自动刷新，401 再刷一次重试',
    syn.includes('expiresAt - 120 > nowSec') && syn.includes('res.status === 401'),
  );
  check(
    '后台每日同步用 alarms（SW 休眠后仍能唤醒）',
    bg.includes('thoth-daily-sync') &&
      bg.includes('chrome.alarms.create') &&
      bg.includes('autoSyncQuiet') &&
      (manifest.permissions ?? []).includes('alarms'),
  );
  check(
    '设置页「管理线上内容」带令牌深链',
    optMain.includes('/manage#access_token=') && optMain.includes('refresh_token='),
  );
  check(
    '管理页接管 hash 会话并抹掉地址栏令牌',
    (() => {
      const p = path.join(ROOT, '../server/web/src/lib/supabase.ts');
      if (!fs.existsSync(p)) return false;
      const w = fs.readFileSync(p, 'utf8');
      return w.includes('setSession') && w.includes('history.replaceState');
    })(),
  );

  check(
    '0.1.8：两个版本号一致',
    JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ===
      manifest.version,
  );

  console.log('\n=== 11. 0.1.9：版本号显示 / 预览关闭 / 管理页排版 ===');
  const sVer = libMain.slice(
    libMain.indexOf('settings-ver'),
    libMain.indexOf('settings-ver') + 120,
  );
  check(
    'debug#6：设置入口版本号取自 manifest，不写死',
    libMain.includes('getManifest().version') && !/v0\.1\.\d/.test(sVer),
  );

  console.log('  预览关闭（独立标签页）：CSS 特异度');
  check(
    'debug#6：standalone 预览只在 :not([hidden]) 时 display:flex',
    /body\.standalone #standalone-preview:not\(\[hidden\]\)\s*\{[^}]*display:\s*flex/.test(
      libCss,
    ),
  );
  check(
    'debug#6：hidden 用 !important 兜底，压得住 1,1,1 的适配器',
    /#standalone-preview\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(libCss),
  );
  check(
    'debug#6：独立预览的关闭挂 pointerdown + click 双通道',
    libMain.includes("spClose?.addEventListener('pointerdown', spHide)") &&
      libMain.includes("spClose?.addEventListener('click', spHide)"),
  );
  const contentSrc = src('src/entrypoints/content.ts');
  check(
    'debug#6：抽屉预览关闭同样双通道，且 Esc 能收掉',
    contentSrc.includes("pvClose?.addEventListener('pointerdown', closePreview)") &&
      contentSrc.includes("pvClose?.addEventListener('click', closePreview)") &&
      contentSrc.includes("e.key !== 'Escape'"),
  );

  console.log('  管理页排版（server/web）');
  const cssPath = path.join(ROOT, '../server/web/src/index.css');
  if (fs.existsSync(cssPath)) {
    const wcss = fs.readFileSync(cssPath, 'utf8');
    check('debug#8：字号刻度再上移（text-sm=16px / text-xs=14px）', wcss.includes('--text-sm: 1rem') && wcss.includes('--text-xs: 0.875rem'));
    check('debug#7：放宽行高与字体栈', /--text-sm--line-height:\s*1\.7/.test(wcss) && wcss.includes('PingFang SC'));
    const dash = fs.readFileSync(path.join(ROOT, '../server/web/src/components/Dashboard.tsx'), 'utf8');
    check('debug#7：侧栏页脚改 flex 压底，不再用 absolute 定位', dash.includes('mt-auto') && !dash.includes('absolute bottom-4'));
  } else {
    check('debug#7：管理页源码存在', false);
  }

  console.log('\n=== 12. debug#8：内容区铺满 / 本地认证邮件链路 ===');
  const dashSrc = fs.readFileSync(path.join(ROOT, '../server/web/src/components/Dashboard.tsx'), 'utf8');
  check(
    'debug#8：主内容区不再锁死在 max-w-5xl / max-w-2xl（表单输入仍可限宽）',
    !dashSrc.includes('mx-auto w-full max-w-5xl') &&
      !dashSrc.includes('<div className="max-w-2xl">') &&
      dashSrc.includes('w-full px-8'),
  );
  check(
    'debug#8：账户页与侧栏都能切到「本地邮箱」',
    dashSrc.includes('打开本地邮箱') && dashSrc.includes('setTab("mailbox")'),
  );
  const mailBox = fs.readFileSync(path.join(ROOT, '../server/web/src/components/Mailbox.tsx'), 'utf8');
  check(
    'debug#8：收件箱说明与实测一致（两封、点其中任意一封即生效）',
    mailBox.includes('任意一封') && mailBox.includes('otp_expired') && !mailBox.includes('两封都要点'),
  );
  const mailRouter = fs.readFileSync(path.join(ROOT, '../server/app/routers/mail.py'), 'utf8');
  check(
    'debug#8：邮件代理仅 dev 且只放行 GoTrue verify 链接',
    mailRouter.includes('settings.env != "dev"') && mailRouter.includes('/auth/v1/verify') && mailRouter.includes('_guard()'),
  );
  const mainSrc = fs.readFileSync(path.join(ROOT, '../server/app/main.py'), 'utf8');
  check(
    'debug#8：根路径重定向到 /manage/，确认链接不再落到 404',
    mainSrc.includes('RedirectResponse(url="/manage/"') && mainSrc.includes('include_router(mail.router'),
  );
  const envEx = fs.readFileSync(path.join(ROOT, '../server/.env.example'), 'utf8');
  check('debug#8：.env.example 写明本地邮件配置', envEx.includes('MAIL_URL=') && envEx.includes('MAIL_PROXY_ENABLED='));

  console.log(`\nFAILED = ${failed}`);
  process.exitCode = failed ? 1 : 0;
}

void main();
