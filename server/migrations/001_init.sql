-- Thothsyn v2 初始表结构（与 app/models.py 对齐；init_db.py 的 create_all 为实际执行来源）
-- 运行：psql "$DATABASE_URL" -f migrations/001_init.sql

CREATE TABLE IF NOT EXISTS profiles (
    id              text PRIMARY KEY,            -- = auth.users.id (uuid)
    level           text NOT NULL DEFAULT 'unverified',  -- unverified|formal|paid|superuser
    is_paid         boolean NOT NULL DEFAULT false,
    is_superuser    boolean NOT NULL DEFAULT false,
    created_at      bigint NOT NULL DEFAULT 0,
    updated_at      bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS folders (
    id          text PRIMARY KEY,               -- 客户端生成 UUID
    user_id     text NOT NULL,
    name        varchar(255) NOT NULL,
    type        text NOT NULL,                 -- business | tag
    created_at  bigint NOT NULL DEFAULT 0,
    updated_at  bigint NOT NULL DEFAULT 0,
    deleted_at  bigint,                         -- 软删时间戳（tombstone）
    CONSTRAINT folders_user_fk FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_folders_user_id ON folders (user_id);
CREATE INDEX IF NOT EXISTS ix_folders_updated_at ON folders (updated_at);
CREATE INDEX IF NOT EXISTS ix_folders_deleted_at ON folders (deleted_at);

CREATE TABLE IF NOT EXISTS captures (
    id          text PRIMARY KEY,               -- 客户端生成 UUID
    user_id     text NOT NULL,
    title       text NOT NULL DEFAULT '',
    url         text NOT NULL DEFAULT '',
    html        text NOT NULL DEFAULT '',        -- full: 仅存链接(html 空); partial: 存 dom html
    text        text NOT NULL DEFAULT '',        -- 预览/搜索纯文本
    kind        text NOT NULL DEFAULT 'full',    -- full | partial
    folder_id   text,                            -- 业务文件夹归属
    tags        jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at  bigint NOT NULL DEFAULT 0,
    updated_at  bigint NOT NULL DEFAULT 0,
    deleted_at  bigint,
    CONSTRAINT captures_user_fk FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_captures_user_id ON captures (user_id);
CREATE INDEX IF NOT EXISTS ix_captures_updated_at ON captures (updated_at);
CREATE INDEX IF NOT EXISTS ix_captures_deleted_at ON captures (deleted_at);
CREATE INDEX IF NOT EXISTS ix_captures_folder_id ON captures (folder_id);
