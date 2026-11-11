# 测试反馈与修复记录

## 2026-11-10 反馈（本轮，已修）

原始反馈：

1. 变更邮箱没有收到变更邮件
2. `http://127.0.0.1:3000/manage/` 中的布局字体感觉还是不合理，不是自动铺满，字体偏小

---

### 1. 变更邮箱没有收到变更邮件

**结论：邮件发出去了，只是没有任何入口能看见它。** 不是发送失败。

实测过程（本机，2026-11-10）：

- 调 GoTrue `PUT /auth/v1/user {email}` 返回 200，用户对象里出现 `new_email` 与 `email_change_sent_at`。
- Mailpit（`http://127.0.0.1:54324`，容器 `supabase_inbucket_supabase`，镜像 `mailpit:v1.31.3`）里确实有 2 封 `Confirm your new email address`，收件人分别是旧邮箱和新邮箱。
- 用户之前试过的 `liuying@keemail.me` / `liuyinggmail@gmail.com` 两封也都在里面。

根因有三层：

1. `supabase start` 起的本地栈用 Mailpit 捕获 **全部** GoTrue 认证邮件，不会投递到真实邮箱；管理页原先只提示「变更邮件已发送，确认后生效」，却没说去哪看。
2. 文案按官方文档 `auth.email.double_confirm_changes` 默认 true 推断「两封都要点」，但**对照实验推翻了它**：点旧邮箱那封或新邮箱那封，任意一封即生效，另一封随即 `otp_expired`；两封都不点则继续用旧邮箱。**【推测，未核实源码】**可能与本地 `GOTRUE_MAILER_AUTOCONFIRM=true` 短路双重确认有关，不外推到生产。
3. 确认链接的 `redirect_to=http://127.0.0.1:3000`（GOTRUE_SITE_URL），而 FastAPI 根路径原本是 **404** —— 就算找到邮件、点了链接，也会落到一个空白页，看起来像「没生效」。

修复：

- `server/app/routers/mail.py`：新增仅 dev 开放的收件箱代理 `/api/mail/messages`、`/api/mail/messages/{id}`。只返回精简字段与白名单过滤后的 GoTrue `verify` 链接，邮件正文按不可信输入处理（纯文本摘要，绝不渲染 HTML）。
- `server/app/routers/config.py`：`/api/config` 增加 `mail_url` / `mail_proxy_enabled`；`config.py` / `.env.example` 增加 `MAIL_URL`、`MAIL_API_URL`、`MAIL_PROXY_ENABLED`。生产把 `ENV` 改非 dev 即自动关闭代理。
- `server/app/main.py`：根路径 302 → `/manage/`。确认链接 303 回来带的 `#access_token/refresh_token` 会被浏览器保留到 `/manage/#...`，管理页 `setSession` 自动接管并抹掉 hash。
- `server/web/src/components/Mailbox.tsx`：新增「本地邮箱」视图，列邮件 + 展开显示「确认邮箱变更」按钮；账户页加说明条与跳转按钮；登录页注册 / 找回密码 / 重发确认的提示也指向本地邮箱。
- 全部文案改为实测结论（两封、点任意一封即生效、`otp_expired` 属正常），不再写未经验证的「两封都要点」。

验证（真实浏览器 + 真实 GoTrue）：

- 端到端：注册 → 改邮箱 → 本地邮箱出现 2 封 → 代理提取 2 条确认链接 → 点其中一封 → 旧邮箱登录 400 / 新邮箱登录 200。
- headless Chrome 打开确认链接：最终 URL `http://127.0.0.1:3000/manage/`，hash 已抹掉，侧栏处于登录态，页脚显示**新邮箱**。
- 实测 `updateUser` 后不点链接：旧邮箱仍可登录、新邮箱 400，确认「必须点一封」。

---

### 2. 布局不是自动铺满、字体偏小

根因：`Dashboard.tsx` 主内容容器写了 `mx-auto w-full max-w-5xl`（锁死 1024px），`AccountView` 又套了一层 `max-w-2xl`（672px）。宽屏下内容挤在中间，右侧一大片空白；上一轮字号虽从 12/14px 提到 13/15px，配这个窄容器还是显小。

修复：

- 去掉两级宽度上限，主容器改 `w-full px-8 py-9 lg:px-12 xl:px-16`，内容随窗口铺满；只对表单输入行保留 `max-w-2xl`，避免 1600px 宽屏下一个输入框拉通整行。
- 字号刻度再上一档：`text-xs` 14px / `text-sm` 16px / `text-base` 17px / `text-xl`（页面标题）25px / `text-2xl` 29px，行高 1.7–1.75，body 16px；显式中文字体栈不变。
- 侧栏 240→256px；信息卡改 6 栅格，邮箱占 2 格不再被截断；表单两张卡在宽屏并排；列表标题 17px、行距与按钮尺寸同步放大；超管表格加宽内边距与标题列。

验证（headless Chrome，1600×1000，真实登录后读取 computedStyle）：

| 指标 | 实测 |
|---|---|
| 视口 / 侧栏 / 主区 | 1600 / 256 / **1344** |
| 主内容容器宽度 | **1344**（与父级一致） |
| 主容器 `max-width` | **none** |
| body / h2 / 次要 / 导航 字号 | 16px / 25px / 14px / 16px |

逐页截图（账户 / 收藏 / 本地邮箱 / 超管）已检查，无溢出、无大片空白列。

---

### 回归

| 项 | 结果 |
|---|---|
| `server/pytest` | 16 passed |
| `web` `tsc --noEmit` / `vite build` | exit 0 |
| `extension` typecheck / build / selftest | exit 0 / 470.94 kB / **165 PASS，FAILED = 0** |

`selftest.mjs` 新增第 12 节 6 条断言，守住「不得再出现 max-w-5xl 主容器」「邮件代理仅 dev 且只放行 verify 链接」「根路径必须重定向」「文案与实测一致」等规则。

### 待你实测

1. `chrome://extensions` 重新加载扩展（本轮没改扩展运行时代码，产物仍是 0.1.9）。
2. 管理页刷新（静态产物已更新）：账户 → 「打开本地邮箱」→ 找一封邮箱变更邮件 → 展开 → 点「确认邮箱变更 ↗」，看新标签页是否自动登录并显示新邮箱。
3. 把窗口拉宽 / 缩窄，确认内容区跟着铺满，字号是否还偏小。

> 备注：dev 数据库里累积了若干本轮与上一轮造的测试账号、示例收藏和 Mailpit 测试邮件；未擅自删除，需要清理请说一声。
