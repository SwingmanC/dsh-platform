-- 升级存量库；勿使用会重建数据表的 db:init。
-- 执行前检查 SELECT email, COUNT(*) FROM t_dsh_users GROUP BY email HAVING COUNT(*) > 1;
-- 邮箱是无租户参数的登录标识，必须全局唯一。重复数据须人工确认后处理。
ALTER TABLE dsh_platform.t_dsh_users
  ADD COLUMN auth_version INT UNSIGNED NOT NULL DEFAULT 0,
  ADD UNIQUE KEY uk_users_email (email);
