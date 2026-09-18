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
DROP TABLE IF EXISTS t_dsh_memory_promotions;
DROP TABLE IF EXISTS t_dsh_memory_records;
DROP TABLE IF EXISTS t_dsh_skill_favorites;
DROP TABLE IF EXISTS t_dsh_skill_reviews;
DROP TABLE IF EXISTS t_dsh_skill_installations;
DROP TABLE IF EXISTS t_dsh_skill_versions;
DROP TABLE IF EXISTS t_dsh_skills;
DROP TABLE IF EXISTS t_dsh_mcp_credentials;
DROP TABLE IF EXISTS t_dsh_mcp_authorizations;
DROP TABLE IF EXISTS t_dsh_mcp_connectors;
DROP TABLE IF EXISTS t_dsh_knowledge_mounts;
DROP TABLE IF EXISTS t_dsh_knowledge_ingestion_jobs;
DROP TABLE IF EXISTS t_dsh_knowledge_chunks;
DROP TABLE IF EXISTS t_dsh_knowledge_document_versions;
DROP TABLE IF EXISTS t_dsh_knowledge_permissions;
DROP TABLE IF EXISTS t_dsh_knowledge_documents;
DROP TABLE IF EXISTS t_dsh_kb_documents;       -- 兼容旧表名(Phase 02 迁移)
DROP TABLE IF EXISTS t_dsh_knowledge_bases;
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
  password_hash VARCHAR(255),                  -- argon2id;仅 OIDC 登录的用户为 NULL(platform 设计 §3.1)
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

-- Memory 长期记忆(Phase 03)
-- 用户私有 Memory 默认严格隔离;租户共享需显式 promote
CREATE TABLE t_dsh_memory_records (
  id              CHAR(36)      PRIMARY KEY,
  tenant_id       CHAR(36)      NOT NULL,
  owner_user_id   CHAR(36)      NOT NULL,
  namespace       VARCHAR(128)  NOT NULL DEFAULT 'default',
  content         TEXT          NOT NULL,
  kind            VARCHAR(20)   NOT NULL DEFAULT 'fact',       -- 'preference' | 'fact' | 'decision' | 'instruction' | 'other'
  content_hash    VARCHAR(64),                                  -- 去重
  visibility      VARCHAR(20)   NOT NULL DEFAULT 'personal',  -- 'personal' | 'tenant_shared'
  source_type     VARCHAR(20)   NOT NULL DEFAULT 'user_fact',  -- 'user_fact' | 'model_inferred' | 'imported' | 'team_approved'
  source_session_id VARCHAR(128),
  source_event_seq  BIGINT,
  confidence      TINYINT,                                     -- 1-10,模型推断的可信度
  revision        INT           NOT NULL DEFAULT 1,
  superseded_by   CHAR(36),                                    -- 冲突时旧记录指向新记录
  extraction_mode VARCHAR(20)   NOT NULL DEFAULT 'manual',     -- 'manual' | 'explicit_user' | 'llm'
  updated_by      CHAR(36),
  review_status   VARCHAR(20)   NOT NULL DEFAULT 'approved',   -- 'pending' | 'approved' | 'rejected'
  reviewed_by     CHAR(36),
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at      DATETIME(3),                                 -- soft delete
  KEY idx_memory_owner (tenant_id, owner_user_id, visibility),
  KEY idx_memory_visibility (visibility, tenant_id),
  KEY idx_memory_kind (kind),
  KEY idx_memory_owner_kind (tenant_id, owner_user_id, kind),
  KEY idx_memory_content_hash (content_hash),
  CONSTRAINT fk_memory_tenant FOREIGN KEY (tenant_id) REFERENCES t_dsh_tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE t_dsh_memory_promotions (
  id              CHAR(36)      PRIMARY KEY,
  memory_id       CHAR(36)      NOT NULL,
  from_visibility VARCHAR(20)   NOT NULL,
  to_visibility   VARCHAR(20)   NOT NULL,
  requested_by    CHAR(36)      NOT NULL,
  reviewed_by     CHAR(36),
  status          VARCHAR(20)   NOT NULL DEFAULT 'pending',     -- 'pending' | 'approved' | 'rejected'
  reason          TEXT,
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_promotion_memory (memory_id),
  KEY idx_promotion_status (status),
  CONSTRAINT fk_promotion_memory FOREIGN KEY (memory_id) REFERENCES t_dsh_memory_records(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 技能广场(platform 设计 Phase 4)
CREATE TABLE t_dsh_skills (
  id              CHAR(36)      PRIMARY KEY,
  tenant_id       CHAR(36)      NOT NULL,
  creator_id      CHAR(36)      NOT NULL,
  name            VARCHAR(128)  NOT NULL,
  slug            VARCHAR(128)  NOT NULL,
  description     TEXT,
  prompt          TEXT,                         -- AI 提示词/技能定义
  tools           JSON,                         -- 工具白名单
  visibility      VARCHAR(20)   NOT NULL DEFAULT 'private', -- 'private' | 'tenant' | 'public'
  status          VARCHAR(20)   NOT NULL DEFAULT 'draft',   -- 'draft' | 'pending_review' | 'published' | 'rejected' | 'suspended' | 'deprecated'
  latest_version  VARCHAR(32)   NOT NULL DEFAULT '1.0.0',
  category        VARCHAR(64),
  source_type     VARCHAR(32),                  -- 'local' | 'git' | 'upload' | 'market'
  source_url      VARCHAR(1024),
  usage_count     INT           NOT NULL DEFAULT 0,
  install_count   INT           NOT NULL DEFAULT 0,
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_skills_tenant (tenant_id),
  KEY idx_skills_visibility (visibility),
  KEY idx_skills_status (status),
  CONSTRAINT fk_skills_tenant FOREIGN KEY (tenant_id) REFERENCES t_dsh_tenants(id),
  CONSTRAINT fk_skills_user FOREIGN KEY (creator_id) REFERENCES t_dsh_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 技能版本
CREATE TABLE t_dsh_skill_versions (
  id              CHAR(36)      PRIMARY KEY,
  skill_id        CHAR(36)      NOT NULL,
  version         VARCHAR(32)   NOT NULL,
  prompt          TEXT          NOT NULL,
  tools           JSON,
  manifest        JSON,
  content_hash    VARCHAR(64),
  package_location VARCHAR(1024),
  source_commit   VARCHAR(64),
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_skill_version (skill_id, version),
  CONSTRAINT fk_version_skill FOREIGN KEY (skill_id) REFERENCES t_dsh_skills(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 技能安装记录
CREATE TABLE t_dsh_skill_installations (
  id              CHAR(36)      PRIMARY KEY,
  tenant_id       CHAR(36)      NOT NULL,
  user_id         CHAR(36)      NOT NULL,
  skill_id        CHAR(36)      NOT NULL,
  version         VARCHAR(32)   NOT NULL DEFAULT '1.0.0',
  enabled         TINYINT(1)    NOT NULL DEFAULT 1,
  installed_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_install_user_skill (user_id, skill_id),
  KEY idx_install_skill (skill_id),
  KEY idx_install_tenant (tenant_id),
  CONSTRAINT fk_install_skill FOREIGN KEY (skill_id) REFERENCES t_dsh_skills(id),
  CONSTRAINT fk_install_user FOREIGN KEY (user_id) REFERENCES t_dsh_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 技能审核记录
CREATE TABLE t_dsh_skill_reviews (
  id              CHAR(36)      PRIMARY KEY,
  skill_id        CHAR(36)      NOT NULL,
  version         VARCHAR(32)   NOT NULL,
  reviewer_id     CHAR(36)      NOT NULL,
  status          VARCHAR(20)   NOT NULL,        -- 'approved' | 'rejected'
  comment         TEXT,
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_review_skill (skill_id),
  CONSTRAINT fk_review_skill FOREIGN KEY (skill_id) REFERENCES t_dsh_skills(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 技能收藏
CREATE TABLE t_dsh_skill_favorites (
  user_id         CHAR(36)      NOT NULL,
  skill_id        CHAR(36)      NOT NULL,
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, skill_id),
  CONSTRAINT fk_fav_skill FOREIGN KEY (skill_id) REFERENCES t_dsh_skills(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 知识库(Phase 05)
CREATE TABLE t_dsh_knowledge_bases (
  id              CHAR(36)      PRIMARY KEY,
  tenant_id       CHAR(36)      NOT NULL,
  creator_id      CHAR(36)      NOT NULL,
  name            VARCHAR(128)  NOT NULL,
  description     TEXT,
  visibility      VARCHAR(20)   NOT NULL DEFAULT 'personal', -- 'personal' | 'tenant'
  category        VARCHAR(64),
  doc_count       INT           NOT NULL DEFAULT 0,
  status          VARCHAR(20)   NOT NULL DEFAULT 'active',
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_kb_tenant (tenant_id, visibility),
  KEY idx_kb_creator (creator_id),
  CONSTRAINT fk_kb_tenant FOREIGN KEY (tenant_id) REFERENCES t_dsh_tenants(id),
  CONSTRAINT fk_kb_user FOREIGN KEY (creator_id) REFERENCES t_dsh_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 知识库权限
CREATE TABLE t_dsh_knowledge_permissions (
  kb_id           CHAR(36)      NOT NULL,
  principal_type  VARCHAR(20)   NOT NULL,         -- 'user' | 'tenant'
  principal_id    CHAR(36)      NOT NULL,
  permission      VARCHAR(20)   NOT NULL,         -- 'read' | 'propose' | 'write' | 'admin'
  granted_by      CHAR(36)      NOT NULL,
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (kb_id, principal_type, principal_id),
  CONSTRAINT fk_perm_kb FOREIGN KEY (kb_id) REFERENCES t_dsh_knowledge_bases(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 知识库文档(增强)
CREATE TABLE t_dsh_knowledge_documents (
  id              CHAR(36)      PRIMARY KEY,
  kb_id           CHAR(36)      NOT NULL,
  filename        VARCHAR(256)  NOT NULL,
  filepath        VARCHAR(1024) NOT NULL,
  file_size       BIGINT        NOT NULL DEFAULT 0,
  content_type    VARCHAR(64),
  status          VARCHAR(20)   NOT NULL DEFAULT 'uploaded',  -- 'uploaded'|'parsing'|'chunking'|'ready'|'failed'|'archived'
  current_version INT           NOT NULL DEFAULT 1,
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_doc_kb (kb_id),
  CONSTRAINT fk_doc_kb FOREIGN KEY (kb_id) REFERENCES t_dsh_knowledge_bases(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 文档版本
CREATE TABLE t_dsh_knowledge_document_versions (
  id              CHAR(36)      PRIMARY KEY,
  doc_id          CHAR(36)      NOT NULL,
  version         INT           NOT NULL,
  content         LONGTEXT,
  content_hash    VARCHAR(64),
  filepath        VARCHAR(1024),
  file_size       BIGINT        DEFAULT 0,
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_doc_version (doc_id, version),
  CONSTRAINT fk_ver_doc FOREIGN KEY (doc_id) REFERENCES t_dsh_knowledge_documents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 文档块
CREATE TABLE t_dsh_knowledge_chunks (
  id              CHAR(36)      PRIMARY KEY,
  doc_id          CHAR(36)      NOT NULL,
  kb_id           CHAR(36)      NOT NULL,
  chunk_index     INT           NOT NULL,
  content         TEXT          NOT NULL,
  token_count     INT           DEFAULT 0,
  embedding       BLOB,                            -- 向量嵌入(可选 Phase 6+)
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_chunk_doc (doc_id),
  KEY idx_chunk_kb (kb_id),
  CONSTRAINT fk_chunk_doc FOREIGN KEY (doc_id) REFERENCES t_dsh_knowledge_documents(id) ON DELETE CASCADE,
  CONSTRAINT fk_chunk_kb FOREIGN KEY (kb_id) REFERENCES t_dsh_knowledge_bases(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 知识库挂载
CREATE TABLE t_dsh_knowledge_mounts (
  id              CHAR(36)      PRIMARY KEY,
  user_id         CHAR(36)      NOT NULL,
  kb_id           CHAR(36)      NOT NULL,
  mount_type      VARCHAR(20)   NOT NULL DEFAULT 'user', -- 'user' | 'session' | 'workspace'
  mount_ref       VARCHAR(128),                         -- session_id or workspace_id
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_mount (user_id, kb_id, mount_type, mount_ref),
  CONSTRAINT fk_mount_kb FOREIGN KEY (kb_id) REFERENCES t_dsh_knowledge_bases(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 导入任务
CREATE TABLE t_dsh_knowledge_ingestion_jobs (
  id              CHAR(36)      PRIMARY KEY,
  kb_id           CHAR(36)      NOT NULL,
  doc_id          CHAR(36),
  source_type     VARCHAR(20)   NOT NULL,             -- 'upload' | 'url'
  source_url      VARCHAR(1024),
  status          VARCHAR(20)   NOT NULL DEFAULT 'pending', -- 'pending'|'parsing'|'chunking'|'ready'|'failed'
  error_message   TEXT,
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at    DATETIME(3),
  KEY idx_job_kb (kb_id),
  CONSTRAINT fk_job_kb FOREIGN KEY (kb_id) REFERENCES t_dsh_knowledge_bases(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- MCP 连接器(Phase 06)
CREATE TABLE t_dsh_mcp_connectors (
  id              CHAR(36)      PRIMARY KEY,
  tenant_id       CHAR(36)      NOT NULL,
  creator_id      CHAR(36)      NOT NULL,
  name            VARCHAR(128)  NOT NULL,
  description     TEXT,
  server_name     VARCHAR(64)   NOT NULL,              -- dsh-mcp-client 的 serverName
  transport       VARCHAR(20)   NOT NULL,              -- 'stdio' | 'streamable-http'
  scope           VARCHAR(20)   NOT NULL DEFAULT 'user',  -- 'user' | 'tenant' | 'platform'
  visibility      VARCHAR(20)   NOT NULL DEFAULT 'private',
  status          VARCHAR(20)   NOT NULL DEFAULT 'active',
  risk_level      VARCHAR(20)   NOT NULL DEFAULT 'low',    -- 'low' | 'medium' | 'high'
  tool_count      INT           NOT NULL DEFAULT 0,
  -- stdio 配置(仅核准模板)
  command         VARCHAR(512),
  args_template   JSON,
  -- HTTP 配置
  endpoint_url    VARCHAR(1024),
  auth_type       VARCHAR(20),                         -- 'none' | 'bearer' | 'oauth2'
  credential_ref  VARCHAR(128),                        -- t_dsh_mcp_credentials 引用
  -- 策略
  allowed_domains JSON,                                -- HTTP allowed URL prefixes
  approved        TINYINT(1)    NOT NULL DEFAULT 0,     -- 管理员审批标记
  approved_by     CHAR(36),
  last_test_at    DATETIME(3),
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_mcp_tenant (tenant_id),
  KEY idx_mcp_scope (scope),
  CONSTRAINT fk_mcp_tenant FOREIGN KEY (tenant_id) REFERENCES t_dsh_tenants(id),
  CONSTRAINT fk_mcp_user FOREIGN KEY (creator_id) REFERENCES t_dsh_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- MCP 授权记录
CREATE TABLE t_dsh_mcp_authorizations (
  id              CHAR(36)      PRIMARY KEY,
  connector_id    CHAR(36)      NOT NULL,
  user_id         CHAR(36)      NOT NULL,
  approved        TINYINT(1)    NOT NULL DEFAULT 1,
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_mcp_auth (connector_id, user_id),
  CONSTRAINT fk_auth_connector FOREIGN KEY (connector_id) REFERENCES t_dsh_mcp_connectors(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- MCP 凭据(信封加密)
CREATE TABLE t_dsh_mcp_credentials (
  id              CHAR(36)      PRIMARY KEY,
  tenant_id       CHAR(36)      NOT NULL,
  connector_id    CHAR(36)      NOT NULL,
  ciphertext      VARBINARY(2048) NOT NULL,
  rotated_at      DATETIME(3)   NOT NULL,
  KEY idx_mcp_cred_connector (connector_id),
  CONSTRAINT fk_cred_connector FOREIGN KEY (connector_id) REFERENCES t_dsh_mcp_connectors(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 最小种子数据(重复执行安全:撞唯一键即跳过)
INSERT IGNORE INTO t_dsh_tenants (id, slug, name, plan, settings)
VALUES (UUID(), 'default', '默认租户', 'standard', JSON_OBJECT());

-- 开发用管理员:admin@local.dev / Admin@12345(仅本地种子;生产必须改密或走 OIDC)
-- 密码哈希为 argon2id(m=19456,t=2,p=1)。改密:pnpm --filter @dsh-platform/gateway hash-password <新密码>
INSERT IGNORE INTO t_dsh_users (id, tenant_id, email, display_name, password_hash, role)
SELECT UUID(), id, 'admin@local.dev', '平台管理员',
       '$argon2id$v=19$m=19456,t=2,p=1$vfd11LJqb11tM5IkzXy2/A$PUrebjGDeZGnuHFpTbnVg6CSCDugzCbOS4fIQBXXnFs',
       'tenant_admin'
FROM t_dsh_tenants WHERE slug = 'default';
