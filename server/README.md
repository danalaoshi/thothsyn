# Thothsyn v2 服务端（FastAPI + 自托管 Supabase）

Thothsyn v2 的云端：本地优先网页收藏扩展的**账户 / 等级 / 收藏云端镜像 / 双向增量同步 / 管理后台**。

- **鉴权**：委托 Supabase（GoTrue），FastAPI 只校验 JWT，不自建用户表；扩展端登录走 `/api/auth/*` 代理
- **数据**：Supabase Postgres（SQLAlchemy async + asyncpg）
- **同步**：`POST /api/sync` 三模式（push / pull / both），基于**服务端自增 `rev`** 游标的增量 + 记录级 LWW 冲突裁决 + 软删 tombstone 传播
- **管理页**：React + Vite SPA，由 FastAPI 静态托管在 `/manage`，支持扩展深链自动登录
- **测试**：pytest + pytest-asyncio，覆盖鉴权 / CRUD / 同步 / LWW / 软删 / 越权 / 等级门禁 / 管理员门禁

## 1. 前置条件

| 工具 | 说明 |
|------|------|
| Docker | 运行 Supabase 全套容器 |
| uv + Python 3.14 | `uv` 管理虚拟环境与依赖 |
| Supabase CLI | `npm install supabase` 后用 `node_modules/.bin/supabase`（brew 安装可能因权限失败） |
| Node 18+ | 仅构建管理页时需要（`web/`） |

## 2. 启动

### 2.1 拉起 Supabase 本地栈

```bash
cd infra/supabase
node_modules路径下的 supabase start   # 或全局安装的 supabase start
```

本地端口（默认）：

| 服务 | 端口 |
|------|------|
| API 网关（Kong / GoTrue） | 54321 |
| Postgres | 54322 |
| Studio | 54323 |
| Mailpit（邮件） | 54324 |

`supabase start` 会打印 anon key / service key / JWT secret，填入 `server/.env`。

### 2.2 配置环境

```bash
cp .env.example .env
# 用 supabase start 输出的真实值覆盖 .env 中的占位
```

### 2.3 安装依赖并建表

```bash
uv sync --extra test
uv run python -m init_db        # 建表 + 执行 migrations/*.sql（幂等，可反复跑）
```

### 2.4 （可选）构建管理页

```bash
cd web
npm install
npm run build                   # 产物输出 web/dist
```

不构建则 `/manage` 不挂载，仅 API 可用。

### 2.5 启动 FastAPI（端口必须是 3000）

```bash
uv run uvicorn app.main:app --host 127.0.0.1 --port 3000
```

> **为什么是 3000？** 本地栈 GoTrue 的 `GOTRUE_SITE_URL=http://127.0.0.1:3000`。
> 管理页浏览器侧要直连 GoTrue（登录 / 注册 / 改密），来源与 site_url 一致才能通过 CORS。
> 换端口需同步修改 Supabase 的 auth.site_url。

访问管理页：`http://127.0.0.1:3000/manage`（侧栏「本地邮箱」可直接看认证邮件，原始 Mailpit 界面在 `http://127.0.0.1:54324`）。

## 3. 测试

```bash
uv run python -m pytest -q       # 16 条用例
```

> 注意：测试会清空（DELETE）实时库三张表的**行**（不删表），
> 开发机上如有正在运行的服务，测试后数据会被清空，属预期行为。

## 4. API 摘要

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/config` | 公开配置（Supabase 网关地址 + anon key + 本地邮箱入口） |
| GET | `/api/mail/messages`、`/api/mail/messages/{id}` | 本地收件箱代理（**仅 dev**；精简字段 + GoTrue 确认链接） |
| GET | `/` | 302 重定向到 `/manage/`（承接认证邮件的确认链接） |
| POST | `/api/auth/signup`、`/login`、`/refresh`、`/recover` | 鉴权代理（转发 GoTrue，返回归一化会话） |
| GET | `/api/me` | 当前账户（同步 GoTrue 邮箱确认态并重算等级） |
| GET/DELETE | `/api/captures`、`/api/captures/{id}` | 收藏列表（folder_id/tag/q 过滤）/ 软删 |
| GET/DELETE | `/api/folders`、`/api/folders/{id}` | 文件夹列表 / 软删 |
| POST | `/api/sync` | 双向增量同步（push/pull/both） |
| POST | `/api/billing/upgrade` | 支付占位（空壳，置 is_paid=true） |
| GET/DELETE | `/api/admin/users`、`/api/admin/captures` | 超管：全部用户 / 全部收藏 |

## 5. 关键设计

### 5.1 鉴权（委托 GoTrue）

- 用户 / 密码 / 邮箱确认全在 Supabase Auth（GoTrue），本应用**不自建用户表**
- `profiles.id == auth.users.id`，首次带 token 访问时懒创建
- JWT 校验（`app/security.py`）双通道：
  1. **HS256 兜底**：用 `SUPABASE_JWT_SECRET` 校验（本地测试伪造 token 用）
  2. **JWKS（生产路径）**：GoTrue 真实签发的是 **ES256** token，
     公钥从 `{SUPABASE_URL}/auth/v1/.well-known/jwks.json` 异步拉取（600s 缓存）

### 5.2 等级门禁

`unverified → formal → paid → superuser`（高者胜）：

| 等级 | 来源 |
|------|------|
| unverified | 默认（邮箱未确认） |
| formal | 邮箱已确认（/api/me 每次同步重算） |
| paid | is_paid=true（支付，当前是空壳） |
| superuser | SUPERUSER_EMAILS 或管理员手动置位 |

未验证邮箱禁止同步（`require_sync_enabled` → 403）；非超管禁止管理 API（`require_superuser` → 403）。

### 5.3 同步协议

- 客户端生成 UUID 作主键（`id`），本地↔云端对齐
- **两套时间轴，别混用**（`migrations/002_sync_rev.sql` 的注释写了踩坑经过）：
  - `updated_at`（epoch ms，**客户端时钟**）= 内容版本，只用于 LWW（大者胜）
  - `rev`（Postgres 序列 `thoth_sync_rev_seq`，**服务端分配**）= 拉取游标，`WHERE rev > cursor`
  - 用 `updated_at` 当游标会出事：两端时钟差几毫秒，刚推上来的记录就「比游标还旧」，
    从此永远拉不下来，删除墓碑也传不出去
- `cursor = 0` 表示全量快照（连存量 `rev=0` 的行一起给），之后一律增量
- 同一次请求里刚写入的 `rev` 不会原样回传（`written_revs` 过滤），省一半流量
- 软删：`deleted_at` 非空 = tombstone，双向传播，拉取时以 `op:"delete"` 返回
- 白名单字段（`CAPTURE_FIELDS` / `FOLDER_FIELDS`）防客户端写 `user_id` 越权；`rev` 不在白名单里
- 所有写强制 `user_id = 当前用户`
- 等级自愈：`require_sync_enabled` 发现 `unverified` 时回查 GoTrue 的真实确认态，
  避免「已确认邮箱但还没调过 `/api/me`」被 403 挡住

### 5.4 本地认证邮件（debug#8）

**事实（本机实测，2026-11-10）**：`supabase start` 起的本地栈把 GoTrue 发出的全部认证邮件投递到 **Mailpit**（`http://127.0.0.1:54324`，容器 `supabase_inbucket_supabase`，镜像 `mailpit:v1.31.3`），**不会发到真实邮箱**。「改邮箱没收到邮件」不是发送失败，是没有查看入口。

- 邮箱变更会发出 **2 封** `Confirm your new email address`：一封到旧邮箱、一封到新邮箱。
  对照实验：点其中**任意一封**确认链接即生效（旧 / 新邮箱登录态互换）；另一封随即 `otp_expired`（正常，不是失败）。两封都不点则继续用旧邮箱。
- 官方 CLI 文档中 `auth.email.double_confirm_changes` 默认 `true`，描述为「新旧邮箱都要确认」；本机实测却是点一封即可。**【推测，未核实源码】**可能与本地 `GOTRUE_MAILER_AUTOCONFIRM=true` 短路了双重确认有关，不要把这个结论外推到生产环境。

**管理页支持**：侧栏「本地邮箱」列出 Mailpit 里的邮件，展开后直接给出确认链接按钮。邮件正文属于不可信输入，只以纯文本摘要展示，链接经白名单过滤（仅放行 `{SUPABASE_URL}/auth/v1/verify`），不渲染邮件 HTML。确认链接点完会 303 到 `GOTRUE_SITE_URL`（3000）并带 `#access_token/refresh_token`，FastAPI 根路径 302 到 `/manage/`，浏览器保留 fragment，管理页 `setSession` 自动接管新会话后抹掉 hash —— 实测落地页已登录且显示新邮箱。

**安全边界**：`/api/mail/*` 只在 `ENV=dev` 且 `MAIL_PROXY_ENABLED=true` 时开放（邮件里含确认令牌）。**不要把这套服务直接暴露到公网**。

**要真正发到邮箱**：在 `infra/supabase/config.toml` 配置 `[auth.email.smtp]`（host/port/user/pass/admin_email/sender_name），并按需设 `[auth.email] enable_confirmations = true`；改完必须 `supabase stop` 再 `supabase start` 才生效（Supabase, "Supabase CLI config"）。当前 `config.toml` 为空、使用 CLI 默认值，未做此改动。

## 6. 已知限制

- 本地栈 GoTrue **注册时自动确认邮箱**（`GOTRUE_MAILER_AUTOCONFIRM=true`），但邮箱变更 / 找回密码邮件仍会发出，只进 Mailpit；要真实投递需按 5.4 配置 SMTP
- **【推测，未核实源码】** 本地 `double_confirm_changes` 的实际行为与官方文档描述不一致，见 5.4
- `POST /api/billing/upgrade` 是**支付空壳**（直接置 is_paid），真实支付集成留待后续
- LWW 依赖客户端时钟：某台设备时钟严重超前时，它的修改会更容易赢
- 测试清行行为见第 3 节说明

## 7. 外部依据（MLA）

Supabase. "Supabase CLI config." *Supabase Docs*, supabase.com/docs/guides/local-development/cli/config. Accessed 10 Nov. 2026.（`auth.email.double_confirm_changes` 默认 true、`auth.email.enable_confirmations` 默认 false、`auth.email.smtp.*` 配置项，以及「修改 config.toml 后需 stop/start 重启」。）
