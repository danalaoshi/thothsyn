# Thothsyn

**Thothsyn** 是一个**本地优先（local-first）**的网页收藏与离线阅读浏览器扩展，配套一个可自托管的后端，提供账号、云端镜像与双向增量同步。

> Thothsyn is a **local-first** browser extension for web clipping and offline reading, paired with a self-hostable backend that provides accounts, cloud mirroring, and two-way incremental sync.

---

## 功能 / Features

- 一键整页收藏、框选局部收藏 / One-click full-page clipping, or clip a partial selection
- 网页内左侧自动隐藏的收藏库抽屉 / In-page auto-hiding library drawer
- 离线快照阅读（沙箱 iframe，永不联网）/ Offline snapshot reader (sandboxed iframe, never touches the network)
- 注册即可云同步，无需付费 / Free cloud sync for any registered user — no payment required
- 后台站内消息 + 桌面通知 / Admin messages + desktop notifications
- 用户留言通道（无需登录）/ User feedback channel (no login required)

---

## 架构 / Architecture

- **扩展 Extension**：Chrome / Firefox / Edge（Manifest V3），数据存本地 IndexedDB
- **后端 Backend**：FastAPI + 自托管 Supabase（GoTrue 鉴权 + Postgres）

扩展默认连接 `http://127.0.0.1:3000`，可在扩展「设置」里改成你自己的服务器地址。

The extension defaults to `http://127.0.0.1:3000`; change it in the extension **Settings** to point at your own server.

---

## 安装 / Install

### 方式一：从 GitHub Releases 安装扩展 / Install the extension from Releases

到 [Releases](../../releases) 页面下载对应浏览器的包：

Download the package for your browser from the [Releases](../../releases) page:

| 浏览器 Browser | 文件 File | 安装方式 How to install |
|---|---|---|
| Chrome | `thothsyn-extension-0.1.17-chrome.zip` | 解压 → 打开 `chrome://extensions` → 开启「开发者模式」→ 「加载已解压的扩展程序」→ 选择解压目录 |
| Edge | `thothsyn-extension-0.1.17-edge.zip` | 解压 → 打开 `edge://extensions` → 开启「开发人员模式」→ 「加载解压缩的扩展」→ 选择解压目录 |
| Firefox | `thothsyn-extension-0.1.17-firefox.xpi` | 打开 `about:addons` → 右上角齿轮 → **Install Add-on From File…** → 选择 `.xpi`（开发者版/ESR 需先关签名强制，见下） |

> **Firefox 说明**：普通正式版（Release）强制要求扩展签名，未签名的 `.xpi` 无法直接安装。请使用 Firefox **开发者版（Developer Edition）/ ESR / 未品牌版（Unbranded）**，在 `about:config` 中将 `xpinstall.signatures.required` 设为 `false`，再安装 `.xpi`。
>
> **Firefox note**: Release builds require a signed add-on, so an unsigned `.xpi` cannot be installed directly. Use Firefox **Developer Edition / ESR / Unbranded**, set `xpinstall.signatures.required` to `false` in `about:config`, then install the `.xpi`.

### 方式二：自托管后端 / Self-host the backend

后端需要 Docker（运行 Supabase 本地栈）+ Python 3.14（uv）+ Node 18+（构建管理页）。

The backend needs Docker (Supabase stack) + Python 3.14 (uv) + Node 18+ (for the admin page).

```bash
# 1. 拉起 Supabase 本地栈（Kong 54321 / Postgres 54322 / Studio 54323 / Mailpit 54324）
cd server/infra/supabase
supabase start

# 2. 配置环境变量
cd ../..
cp server/.env.example server/.env
# 用 supabase start 输出的 anon key / service key / JWT secret 覆盖 .env 占位
# 关键：把 SUPERUSER_EMAILS 设为你的邮箱，管理页才会出现「消息」「用户留言」入口

# 3. 安装依赖并建表
cd server
uv sync --extra test
uv run python -m init_db

# 4.（可选）构建管理页
cd web && npm install && npm run build && cd ..

# 5. 启动（端口必须是 3000，与 GoTrue 的 site_url 一致）
uv run uvicorn app.main:app --host 0.0.0.0 --port 3000
```

管理页地址：`http://<你的服务器IP>:3000/manage`

**托管后端（不想自己搭 Supabase 时）**：用 supabase.com 免费项目 + Render / Railway / Fly 免费层即可，详见 `server/README.md` 第 8 节。部署后会得到一个 `https://...` 地址；把扩展「设置 → 服务器地址」填成它即可（默认值仍是 `http://127.0.0.1:3000`）。

**Hosted backend (if you don't want to run Supabase yourself)**: use a supabase.com free project + Render / Railway / Fly free tier — see `server/README.md` §8. You'll get a `https://...` URL; paste it into the extension **Settings → Server URL** (the default is still `http://127.0.0.1:3000`).

> 公网部署前请务必：改默认数据库口令、配置真实 SMTP、关闭 `/api/mail/*`、设置 CORS 白名单、做好数据备份。详见 `server/README.md`。
>
> Before any public deployment: change default DB credentials, configure real SMTP, disable `/api/mail/*`, set a CORS allowlist, and back up data. See `server/README.md`.

---

## 试用 / Try it out

1. **装好扩展**，打开任意网页：
   - 工具栏单击 = 收藏整页
   - 右键 = 整页 / 框选局部 / 打开收藏库
2. **连后端**：扩展「设置」→「服务器地址」填你的后端地址（如 `http://<服务器IP>:3000`），默认是 `http://127.0.0.1:3000`。
3. **注册账号**：扩展「设置」→ 注册 / 登录（走后端 GoTrue 鉴权）。
4. **云同步**：注册即可同步，无需付费。设置里可开启「每日自动同步」。
5. **留言**：设置页「给我留言」可匿名给开发者留言（≤500 字，留联系方式便于回访）。

---

1. **Install the extension**, then open any web page:
   - Toolbar click = clip the whole page
   - Right-click = full page / partial selection / open library
2. **Connect to backend**: Extension **Settings** → **Server URL** → enter your backend address (e.g. `http://<server-ip>:3000`); default is `http://127.0.0.1:3000`.
3. **Sign up**: Extension **Settings** → register / log in (via backend GoTrue).
4. **Sync**: Any registered user can sync — no payment needed. Enable "daily auto-sync" in settings.
5. **Feedback**: The "Leave feedback" panel in Settings sends a message to the developer (≤500 chars; contact info required for follow-up).

---

## 从源码构建 / Build from source

```bash
# 扩展（需 Node 18+）
cd extension
npm install
npm run zip            # Chrome / Edge → .output/thothsyn-extension-0.1.17-chrome.zip
npm run zip:firefox    # Firefox → .output/thothsyn-extension-0.1.17-firefox.zip（已含 --mv3）
```

> Edge 与 Chrome 同为 Chromium Manifest V3，使用同一个打包产物即可。
> Edge and Chrome are both Chromium MV3, so the same package is used for both.

---

## 隐私 / Privacy

- 离线快照只在沙箱 iframe 中渲染，永不联网；外部图片在预览中不会加载。
- 云同步 / 留言均由用户主动触发；服务端仅保存你上传的收藏、留言与联系方式。
- Offline snapshots render only in a sandboxed iframe and never touch the network. Sync/feedback are user-initiated; the server stores only what you upload.

---

## 联系方式 / Contact

问题、建议或合作请联系 / Questions, suggestions, or collaboration:

**bayeethmonkey@gmail.com**
