# REWORK-06 — Platform MCP Data Model Audit

> 审计日期:2026-09-18
> 真源:`db/schema.sql` + `apps/gateway/src/repositories/mcp-repository.ts`

---

## 表结构

### t_dsh_mcp_connectors(catalog / template)

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | CHAR(36) PK | UUID |
| `tenant_id` | CHAR(36) FK | 租户 |
| `creator_id` | CHAR(36) FK | 创建者 |
| `name` | VARCHAR(128) | 显示名(非 runtime name) |
| `server_name` | VARCHAR(64) | **Runtime serverName**(`[A-Za-z0-9_-]{1,32}`) |
| `transport` | VARCHAR(20) | `stdio` / `streamable-http` |
| `scope` | VARCHAR(20) | `user` / `tenant` / `platform` |
| `status` | VARCHAR(20) | `active` / `disabled` |
| `risk_level` | VARCHAR(20) | low/medium/high |
| `command` | VARCHAR(512) | stdio 命令 |
| `endpoint_url` | VARCHAR(1024) | streamable-http URL |
| `auth_type` | VARCHAR(20) | none/bearer/oauth2 |
| `credential_ref` | VARCHAR(128) | 凭据引用 |
| `approved` | TINYINT(1) | 管理员审批标记 |
| `approved_by` | CHAR(36) | 审批人 |

### t_dsh_mcp_authorizations(per-user)

| 列 | 类型 | 说明 |
|----|------|------|
| `connector_id` | CHAR(36) FK | connector |
| `user_id` | CHAR(36) | 授权用户 |
| `approved` | TINYINT(1) | 授权有效 |

### t_dsh_mcp_credentials(加密)

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | CHAR(36) PK | UUID |
| `tenant_id` | CHAR(36) | 租户 |
| `connector_id` | CHAR(36) FK | connector |
| `ciphertext` | VARBINARY(2048) | **AES-256-GCM envelope**(`v1.<iv>.<tag>.<ct>`) |
| `rotated_at` | DATETIME(3) | 轮换时间 |

---

## 12 个审计问题

| # | 问题 | 答案 |
|---|------|------|
| 1 | connector 是 catalog template 还是 user arbitrary config? | 两者兼有:普通用户可建 private draft;`scope=tenant/platform` 为共享模板。进入 Runtime 必须 approved。 |
| 2 | approve 权限是谁? | **修正为服务端管理员**(`tenant_admin`/`operator`)。原实现无权限校验。 |
| 3 | authorize 权限是谁? | 用户本人;需 connector approved + active + transport 合规。 |
| 4 | transport/config 存哪里? | `t_dsh_mcp_connectors.transport` + `command`/`endpoint_url`/`auth_type`。 |
| 5 | mcp_credentials 是否足以安全持久化? | `ciphertext` VARBINARY 存版本化 envelope(iv/tag/ct 内嵌)。无需 migration。 |
| 6 | 是否存过 plaintext secret? | 否;Phase 06 起只存加密 envelope。 |
| 7 | serverName/runtimeName 稳定字段? | `server_name`,已存在;审批/创建时校验 `[A-Za-z0-9_-]{1,32}`。 |
| 8 | 同用户两 connector 是否可能 serverName 冲突? | 是;authorize 时服务端拒绝(不等 DSH 启动报错)。 |
| 9 | revoke 删除 credential 还是只解除授权? | 只解除授权(`DELETE authorizations`);credential 保留供重新授权。 |
| 10 | connector 删除/禁用时授权如何失效? | disable → status=disabled → 投影排除 + 刷新已授权者投影。 |
| 11 | 是否存在 team/tenant connector? | 是(`scope=tenant/platform`)。 |
| 12 | 普通用户能否提交任意 command/url? | url 需通过 egress policy;stdio 默认禁用。 |

---

## 结论

- Schema 已就绪,无需 migration(credential envelope 复用 `ciphertext`)
- approve 权限边界需在 service 层修正(已完成)
- 投影查询 `listProjectableAuthorized` 在 SQL 层做 approved + active + authorized + visibility 过滤