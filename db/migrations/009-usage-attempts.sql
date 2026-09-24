-- 既有事件均来自旧版成功消息采集；保留原统计值，新增字段使用兼容默认值。
-- 使用完整表名，让 DBeaver 可将整个文件作为一条 SQL 执行。
ALTER TABLE dsh_platform.t_dsh_usage_events
  ADD COLUMN event_type VARCHAR(16) NOT NULL DEFAULT 'message' AFTER model,
  ADD COLUMN turn_no BIGINT NULL AFTER event_type,
  ADD COLUMN step_no BIGINT NULL AFTER turn_no,
  ADD COLUMN usage_known TINYINT(1) NOT NULL DEFAULT 1 AFTER step_no;
