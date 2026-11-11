-- Thothsyn v2.1：同步游标改用服务端自增版本号 rev
--
-- 为什么必须加这一列：
--   updated_at 由客户端时钟生成（LWW 裁决用），而拉取游标是服务端时间。
--   两端时钟差几毫秒，刚推送的记录 updated_at 就会小于上一次返回的
--   server_cursor，于是「永远拉不下来」——另一端看不到它，删除墓碑也传不出去。
--   rev 由 Postgres 序列分配，与任何时钟无关，天然单调。
--
-- 幂等：可反复执行（init_db.py 每次启动都会跑一遍）。

CREATE SEQUENCE IF NOT EXISTS thoth_sync_rev_seq START 1;

ALTER TABLE folders  ADD COLUMN IF NOT EXISTS rev bigint NOT NULL DEFAULT 0;
ALTER TABLE captures ADD COLUMN IF NOT EXISTS rev bigint NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS ix_folders_rev  ON folders  (rev);
CREATE INDEX IF NOT EXISTS ix_captures_rev ON captures (rev);

-- 存量行补初始值：否则它们 rev=0，任何游标都拉不到
UPDATE folders  SET rev = nextval('thoth_sync_rev_seq') WHERE rev = 0;
UPDATE captures SET rev = nextval('thoth_sync_rev_seq') WHERE rev = 0;
