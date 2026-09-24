-- 历史行的零值无法区分“确实为零”和“未上报”，默认标记为未知。
-- 历史非零值则能证明该字段曾被上报。
ALTER TABLE dsh_platform.t_dsh_usage_events
  ADD COLUMN cache_read_known TINYINT(1) NOT NULL DEFAULT 0 AFTER usage_known,
  ADD COLUMN cache_write_known TINYINT(1) NOT NULL DEFAULT 0 AFTER cache_read_known,
  ADD COLUMN reasoning_known TINYINT(1) NOT NULL DEFAULT 0 AFTER cache_write_known;
