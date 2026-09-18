-- Phase 07 Memory Runtime:扩展 t_dsh_memory_records
-- 非破坏性迁移(开发环境);生产按标准 migration 流程执行。
ALTER TABLE t_dsh_memory_records
  ADD COLUMN kind            VARCHAR(20)  NOT NULL DEFAULT 'fact' AFTER content,
  ADD COLUMN content_hash    VARCHAR(64)  NULL AFTER kind,
  ADD COLUMN revision        INT          NOT NULL DEFAULT 1 AFTER confidence,
  ADD COLUMN superseded_by   CHAR(36)     NULL AFTER revision,
  ADD COLUMN extraction_mode VARCHAR(20)  NOT NULL DEFAULT 'manual' AFTER superseded_by,
  ADD COLUMN updated_by      CHAR(36)     NULL AFTER extraction_mode,
  ADD COLUMN deleted_at      DATETIME(3)  NULL AFTER updated_at,
  ADD KEY idx_memory_kind (kind),
  ADD KEY idx_memory_owner_kind (tenant_id, owner_user_id, kind),
  ADD KEY idx_memory_content_hash (content_hash);
