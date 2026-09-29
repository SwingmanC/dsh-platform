USE dsh_platform;

CREATE TABLE IF NOT EXISTS t_dsh_usage_events (
  event_key VARCHAR(255) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  session_id VARCHAR(128) NOT NULL,
  event_seq BIGINT NOT NULL,
  provider VARCHAR(64) NOT NULL DEFAULT 'unknown',
  model VARCHAR(128) NOT NULL DEFAULT 'unknown',
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens BIGINT NOT NULL DEFAULT 0,
  occurred_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_usage_tenant_time (tenant_id, occurred_at),
  KEY idx_usage_user_time (tenant_id, user_id, occurred_at),
  KEY idx_usage_model_time (tenant_id, model, occurred_at),
  CONSTRAINT fk_usage_events_tenant FOREIGN KEY (tenant_id) REFERENCES t_dsh_tenants(id),
  CONSTRAINT fk_usage_events_user FOREIGN KEY (user_id) REFERENCES t_dsh_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
