-- 审计第一期。只对尚未执行此迁移的存量库执行一次。
-- 历史字段保持 NULL，不推断历史操作者、结果或来源。
ALTER TABLE dsh_platform.t_dsh_audit_events
  ADD COLUMN actor_name VARCHAR(128) NULL,
  ADD COLUMN resource_type VARCHAR(64) NULL,
  ADD COLUMN resource_id VARCHAR(256) NULL,
  ADD COLUMN result VARCHAR(16) NULL,
  ADD COLUMN reason_code VARCHAR(64) NULL,
  ADD COLUMN request_id VARCHAR(128) NULL,
  ADD COLUMN client_ip VARCHAR(45) NULL,
  ADD COLUMN user_agent VARCHAR(512) NULL,
  ADD COLUMN source VARCHAR(16) NULL,
  ADD KEY idx_audit_actor_time (tenant_id, actor, at, id),
  ADD KEY idx_audit_action_time (tenant_id, action, at, id);
