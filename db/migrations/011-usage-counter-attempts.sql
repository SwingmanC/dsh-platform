-- 此计数器每插入一条模型结算事件加一，实际口径是“尝试次数”。
ALTER TABLE dsh_platform.t_dsh_usage_counters
  CHANGE COLUMN requests attempts BIGINT NOT NULL DEFAULT 0;
