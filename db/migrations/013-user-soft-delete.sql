-- 人员逻辑删除：保留原用户行及所有历史资产关联。
ALTER TABLE dsh_platform.t_dsh_users
  ADD COLUMN deleted_at DATETIME(3) NULL DEFAULT NULL;
