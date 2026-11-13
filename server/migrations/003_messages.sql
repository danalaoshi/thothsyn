-- Thothsyn v2.2（0.1.11）：后台消息推送通道的站内消息表
--
-- app/models.py 的 Message 与 create_all 是实际建表来源，这里给纯 psql 部署
-- 补一份等价 DDL，并加一条覆盖「按收件人增量拉取」的复合索引。
-- id 是 bigserial 主键，同时充当客户端 since 游标，与任何客户端时钟无关。
-- recipient_id 为空表示全体用户可见，非空表示只对该 user_id 可见。
-- 幂等：可反复执行（init_db.py 每次启动都会跑一遍）。

CREATE TABLE IF NOT EXISTS messages (
    id           bigserial PRIMARY KEY,
    sender_id    varchar(36) NOT NULL,
    recipient_id varchar(36),
    title        varchar(200) NOT NULL,
    body         text NOT NULL DEFAULT '',
    created_at   bigint NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ix_messages_recipient_seq ON messages (recipient_id, id);
