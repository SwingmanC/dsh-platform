-- dsh_platform 数据库完整 DDL
-- 来源:docs/design/MULTI-TENANT-DEPLOYMENT-PLAN.zh-CN.md §3.1(总方案 9 表)
--     + docs/design/platform-user-binding-design.zh.md §7(工作区表与 agent_bindings 增列,
--       增列已折叠进 CREATE,不再需要文档中的 ALTER)。
-- 约定:MySQL 8.0+、InnoDB、utf8mb4;表名统一 t_dsh_ 前缀;主键 CHAR(36) 为应用层
--       生成的 UUID(可用 UUIDv7 改善索引局部性);时间列 DATETIME(3) 由应用层统一写 UTC
--       (避开 TIMESTAMP 类型的 2038 上限);MySQL 会解析但忽略列内 REFERENCES,
--       外键一律写成表级 FOREIGN KEY 子句。
-- 幂等:先按外键依赖的逆序 DROP,再按依赖顺序 CREATE;含最小种子数据。

SET NAMES utf8mb4;

CREATE DATABASE IF NOT EXISTS dsh_platform
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

USE dsh_platform;

-- 逆序清理(外键依赖的下游先删)
DROP TABLE IF EXISTS t_dsh_audit_events;
DROP TABLE IF EXISTS t_dsh_sync_cursors;
DROP TABLE IF EXISTS t_dsh_runtimes;
DROP TABLE IF EXISTS t_dsh_usage_counters;
DROP TABLE IF EXISTS t_dsh_quotas;
DROP TABLE IF EXISTS t_dsh_provider_credentials;
DROP TABLE IF EXISTS t_dsh_agent_bindings;
DROP TABLE IF EXISTS t_dsh_workspaces;
DROP TABLE IF EXISTS t_dsh_users;
DROP TABLE IF EXISTS t_dsh_tenants;

-- 租户
CREATE TABLE t_dsh_tenants (
  id            CHAR(36)      PRIMARY KEY,
  slug          VARCHAR(64)   NOT NULL,        -- URL 标识
  name          VARCHAR(128)  NOT NULL,
  plan          VARCHAR(32)   NOT NULL DEFAULT 'standard',
  settings      JSON          NOT NULL,        -- 模型白名单、工具白名单、审批策略、沙箱模式
  created_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_tenants_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 用户(归属单一租户;SSO 场景用 external_sub 关联)
CREATE TABLE t_dsh_users (
  id            CHAR(36)      PRIMARY KEY,
  tenant_id     CHAR(36)      NOT NULL,
  external_sub  VARCHAR(128),                  -- OIDC subject,普通索引
  email         VARCHAR(254)  NOT NULL,
  display_name  VARCHAR(128)  NOT NULL,
  role          VARCHAR(32)   NOT NULL DEFAULT 'member',  -- 'tenant_admin' | 'operator' | 'member'
  status        VARCHAR(16)   NOT NULL DEFAULT 'active',  -- active | disabled
  created_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_users_tenant_email (tenant_id, email),
  KEY idx_users_external_sub (external_sub),
  CONSTRAINT fk_users_tenant FOREIGN KEY (tenant_id) REFERENCES t_dsh_tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 工作区登记(platform 设计 §7:平台首页分组、存在性巡检、迁移谱系的载体)
-- canonical_path 取 VARCHAR(512):与 user_id 组成唯一键后仍在 InnoDB
-- 3072 字节索引上限内((36+512)×4 = 2192);超长路径需改用规范化哈希入键。
CREATE TABLE t_dsh_workspaces (
  id             CHAR(36)      PRIMARY KEY,
  user_id        CHAR(36)      NOT NULL,
  canonical_path VARCHAR(512)  NOT NULL,    -- 规范化绝对路径
  display_name   VARCHAR(128)  NOT NULL,
  last_used_at   DATETIME(3),
  archived_at    DATETIME(3),
  missing_since  DATETIME(3),               -- 巡检发现缺失的时间,NULL=在
  UNIQUE KEY uk_workspaces_user_path (user_id, canonical_path),
  CONSTRAINT fk_workspaces_user FOREIGN KEY (user_id) REFERENCES t_dsh_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ★ Agent↔用户绑定(dsh SessionId 与外部身份的映射,权威在网关;不在请求路径上)
-- 含 platform 设计 §7 的增量列 workspace_id / migrated_from(已折叠,无需 ALTER)。
CREATE TABLE t_dsh_agent_bindings (
  session_id    VARCHAR(128)  PRIMARY KEY,     -- dsh SessionId(品牌化字符串,序列化同 string;MySQL 的 TEXT 不能做主键)
  tenant_id     CHAR(36)      NOT NULL,
  user_id       CHAR(36)      NOT NULL,
  runtime_id    CHAR(36),                      -- 当前持有写句柄的 runtime 进程
  title         VARCHAR(512),
  workspace     VARCHAR(1024) NOT NULL,        -- 该会话的 cwd(绝对路径)
  workspace_id  CHAR(36),                      -- 关联登记的工作区(platform 设计 §7)
  migrated_from VARCHAR(128),                  -- S2 迁移的源会话 id
  status        VARCHAR(16)   NOT NULL DEFAULT 'active',
  created_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_bindings_user_recent (user_id, updated_at DESC),
  KEY idx_bindings_tenant_user (tenant_id, user_id),
  KEY idx_bindings_workspace (workspace_id),
  CONSTRAINT fk_bindings_tenant FOREIGN KEY (tenant_id) REFERENCES t_dsh_tenants(id),
  CONSTRAINT fk_bindings_user FOREIGN KEY (user_id) REFERENCES t_dsh_users(id),
  CONSTRAINT fk_bindings_workspace FOREIGN KEY (workspace_id) REFERENCES t_dsh_workspaces(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 租户级 LLM 凭据(信封加密存储)
CREATE TABLE t_dsh_provider_credentials (
  tenant_id     CHAR(36)      NOT NULL,
  provider      VARCHAR(32)   NOT NULL,        -- 'deepseek' | ...
  ciphertext    VARBINARY(2048) NOT NULL,      -- KMS/信封加密后的 key
  rotated_at    DATETIME(3)   NOT NULL,
  PRIMARY KEY (tenant_id, provider),
  CONSTRAINT fk_credentials_tenant FOREIGN KEY (tenant_id) REFERENCES t_dsh_tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 配额与用量
CREATE TABLE t_dsh_quotas (
  tenant_id     CHAR(36)      NOT NULL,
  kind          VARCHAR(64)   NOT NULL,        -- 'concurrent_runtimes' | 'sessions' | 'daily_tokens'
  limit_val     BIGINT        NOT NULL,
  PRIMARY KEY (tenant_id, kind),
  CONSTRAINT fk_quotas_tenant FOREIGN KEY (tenant_id) REFERENCES t_dsh_tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE t_dsh_usage_counters (
  tenant_id     CHAR(36)      NOT NULL,
  day           DATE          NOT NULL,
  tokens_in     BIGINT        NOT NULL DEFAULT 0,
  tokens_out    BIGINT        NOT NULL DEFAULT 0,
  requests      BIGINT        NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- runtime 进程注册表(也可只放 Redis,落库便于审计)
CREATE TABLE t_dsh_runtimes (
  id             CHAR(36)      PRIMARY KEY,
  user_id        CHAR(36)      NOT NULL,
  host           VARCHAR(255)  NOT NULL,
  dsh_version    VARCHAR(32)   NOT NULL,       -- 钉住的 dsh 版本
  state          VARCHAR(16)   NOT NULL,       -- starting | ready | draining | dead
  last_heartbeat DATETIME(3)   NOT NULL,
  pid            INT,
  CONSTRAINT fk_runtimes_user FOREIGN KEY (user_id) REFERENCES t_dsh_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 多设备同步游标
CREATE TABLE t_dsh_sync_cursors (
  session_id    VARCHAR(128)  NOT NULL,
  device_id     VARCHAR(64)   NOT NULL,
  last_seq      BIGINT        NOT NULL,
  PRIMARY KEY (session_id, device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 审计事件
CREATE TABLE t_dsh_audit_events (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id  CHAR(36),
  actor      CHAR(36),
  action     VARCHAR(64)   NOT NULL,           -- login | logout | session.enter | workspace.missing | ...
  subject    VARCHAR(256),
  payload    JSON,
  at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_audit_tenant_time (tenant_id, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 最小种子数据(重复执行安全:撞唯一键即跳过)
INSERT IGNORE INTO t_dsh_tenants (id, slug, name, plan, settings)
VALUES (UUID(), 'default', '默认租户', 'standard', JSON_OBJECT());

INSERT IGNORE INTO t_dsh_users (id, tenant_id, email, display_name, role)
SELECT UUID(), id, 'admin@local.dev', '平台管理员', 'tenant_admin'
FROM t_dsh_tenants WHERE slug = 'default';
