"""运行时配置：从环境变量 / .env 读取。

关键项（来自 `supabase start` 输出或自托管配置）：
- database_url      : asyncpg 连接串，指向 Supabase Postgres
- supabase_jwt_secret: 用于校验 GoTrue 签发的用户 JWT（HS256）
- supabase_url      : GoTrue 网关地址（用于 /api/me 拉取邮箱确认状态）
- supabase_anon_key : 公开 anon key（调用 GoTrue user 接口需要）
"""
from __future__ import annotations
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    env: str = "dev"
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:54322/postgres"
    supabase_jwt_secret: str = ""
    supabase_url: str = "http://localhost:8000"
    supabase_anon_key: str = ""
    supabase_service_role_key: str = ""
    # 逗号分隔的管理员邮箱。命中名单的账号在每次鉴权时都会确保 is_superuser=true，
    # 大小写不敏感；名单变更或 profiles 行被清空后可自愈。生产环境应显式配置。
    superuser_emails: str = ""
    # 名单为空时的本地便利引导：把「第一个通过鉴权且库中尚无超管」的账号提为超管。
    # 默认关闭；ENV=prod 时无论如何都强制禁用，避免公网第一个注册者拿到管理权限。
    bootstrap_first_superuser: bool = False
    cors_origins: str = "*"
    api_prefix: str = "/api"

    # 本地开发邮件：`supabase start` 起的 Mailpit 会捕获 GoTrue 发出的全部认证邮件，
    # 不会投递到真实邮箱。管理页通过后端代理读取，避免浏览器跨域。
    mail_url: str = "http://127.0.0.1:54324"
    mail_api_url: str = "http://127.0.0.1:54324"
    # 只在 env=dev 且此开关为真时开放 /api/mail/*（邮件里含确认令牌）
    mail_proxy_enabled: bool = True

    @property
    def superuser_email_set(self) -> set[str]:
        return {e.strip().lower() for e in self.superuser_emails.split(",") if e.strip()}

    @property
    def allow_first_user_bootstrap(self) -> bool:
        """自动引导仅在「非生产 + 显式开启 + 未配置名单」三个条件同时成立时允许。"""
        return (
            self.env.strip().lower() != "prod"
            and self.bootstrap_first_superuser
            and not self.superuser_email_set
        )


settings = Settings()
