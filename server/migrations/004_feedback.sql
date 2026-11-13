-- Thothsyn v2.3（0.1.12）：用户留言表
--
-- app/models.py 的 Feedback 与 create_all 是实际建表来源，这里给纯 psql 部署
-- 补一份等价 DDL，并加三条覆盖管理页查询的索引。
-- 匿名留言允许 user_id / account_email 为空；contact 必填，是回访的唯一入口。
-- 幂等：可反复执行（init_db.py 每次启动都会跑一遍）。

CREATE TABLE IF NOT EXISTS feedback (
    id             bigserial PRIMARY KEY,
    user_id        varchar(36),
    account_email  varchar(255),
    contact_type   varchar(10) NOT NULL,
    contact        varchar(200) NOT NULL,
    content        text NOT NULL,
    client_version varchar(20) NOT NULL DEFAULT '',
    created_at     bigint NOT NULL DEFAULT 0,
    is_read        boolean NOT NULL DEFAULT false,
    read_at        bigint
);

CREATE INDEX IF NOT EXISTS ix_feedback_created ON feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS ix_feedback_unread ON feedback (is_read, id DESC);
CREATE INDEX IF NOT EXISTS ix_feedback_contact_time ON feedback (contact, created_at DESC);
