-- 当前本地 dsh_platform 库的专项历史修正。
-- 已只读确认 ID 1–28 由旧写入入口按 UTC+08:00 保存，ID 29 起使用 UTC。
-- 其他环境必须先核实旧数据时区与切换边界，不能直接照搬 ID 28。
-- 保存原始时间，并以原值匹配更新，重复执行不会再次减 8 小时。
CREATE TABLE IF NOT EXISTS dsh_platform.t_dsh_audit_time_corrections (
  audit_event_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  original_at DATETIME(3) NOT NULL,
  corrected_at DATETIME(3) NOT NULL,
  recorded_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

START TRANSACTION;

INSERT INTO dsh_platform.t_dsh_audit_time_corrections
  (audit_event_id, original_at, corrected_at, recorded_at)
SELECT e.id, e.at, DATE_SUB(e.at, INTERVAL 8 HOUR), UTC_TIMESTAMP(3)
FROM dsh_platform.t_dsh_audit_events e
WHERE e.id BETWEEN 1 AND 28
  AND e.actor_name IS NULL AND e.resource_type IS NULL AND e.resource_id IS NULL
  AND e.result IS NULL AND e.reason_code IS NULL AND e.request_id IS NULL
  AND e.client_ip IS NULL AND e.user_agent IS NULL AND e.source IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM dsh_platform.t_dsh_audit_time_corrections c WHERE c.audit_event_id = e.id
  );

UPDATE dsh_platform.t_dsh_audit_events e
JOIN dsh_platform.t_dsh_audit_time_corrections c ON c.audit_event_id = e.id
SET e.at = c.corrected_at
WHERE e.id BETWEEN 1 AND 28 AND e.at = c.original_at
  AND e.actor_name IS NULL AND e.resource_type IS NULL AND e.resource_id IS NULL
  AND e.result IS NULL AND e.reason_code IS NULL AND e.request_id IS NULL
  AND e.client_ip IS NULL AND e.user_agent IS NULL AND e.source IS NULL;

COMMIT;
