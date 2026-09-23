# Phase 01 — Security Gap List

> 审计日期:2026-09-16

---

## 1. 已修复(骨架阶段遗留,当前已正确)

| 问题 | 位置 | 说明 |
|---|---|---|
| `POST /api/runtimes/ensure` 接收客户端 `userId` | `apps/gateway/src/index.ts:79-92` | ✅ 实际代码已从 `req.platformSession.data` 读取,非 body |

---

## 2. 待修复安全缺口

### GAP-01: 资源 DELETE 返回 403 而非 404

**位置**: `apps/gateway/src/routes/features.ts:46,107`

**问题**: `DELETE /api/skills/:id` 和 `DELETE /api/connectors/:id` 在资源不属于当前用户时返回 `403`,违反设计文档"越权资源一律 404(防探测)"约定。

**影响**: 攻击者可探测资源存在性(遍历 ID 列表,403=存在,404=不存在)。

**修复**: 将 `return reply.code(403).send({ error: 'forbidden' })` 改为 `return reply.code(404).send({ error: 'not-found' })`。

### GAP-02: feature API 未统一校验 tenant 归属

**位置**: `apps/gateway/src/routes/features.ts:9-14,54-57,79-83`

**问题**: skills/knowledge-bases/connectors 的 GET 列表查询使用 `creator_id = ? OR tenant_id = (SELECT ...)`,允许跨租户看到其他租户的 `scope='public'`/`scope='enterprise'` 资源。这本身符合设计(public/enterprise 范围),但未校验本租户内成员应有范围约束。

**影响**: 低风险,但 scope 过滤逻辑不够严格。

**建议**: 后续阶段应补充 tenant scope 的精确权限校验,避免用户看到本租户外的资源。

### GAP-03: 无 tenant 层级目录隔离

**位置**: `apps/gateway/src/supervisor.ts:157-158`

**问题**: DSH_HOME 和 workspace root 路径为 `homes/<userId>` 和 `workspaces/<userId>`,未包含 tenant 层级。若不同租户的用户 ID 冲突(概率低但可能),将导致目录交叉。

**影响**: 跨租户文件系统隔离依赖于 userId 的唯一性(UUID),理论上安全但偏离设计文档预期。

**建议**: 改为 `homes/<tenantId>/<userId>` 和 `workspaces/<tenantId>/<userId>`。

### GAP-04: session-sync 硬编码 Host

**位置**: `apps/gateway/src/session-sync.ts:65`

**问题**: `callDshRpc` 函数向实例发请求时硬编码 `host: 'localhost:8080'`。

**影响**: 若 DSH_UI_AUTHORITY 非 localhost:8080,实例的 Host 围栏可能拒绝请求。

**修复**: 使用 `config.dsh.uiAuthority` 替代硬编码值。

### GAP-05: 无凭据加密解密实现

**位置**: `apps/gateway/src/supervisor.ts:93`

**问题**: `// TODO(T2 凭据): 从 t_dsh_provider_credentials 解密后注入 DEEPSEEK_API_KEY`

**影响**: 当前 LLM 凭据仅通过 `.env` 的 `DEEPSEEK_API_KEY` 注入,未使用 `t_dsh_provider_credentials` 表的信封加密方案。

**建议**: 在 P2 阶段实现 KMS/信封加密解密流程。

### GAP-06: 无测试覆盖

**影响**: 全部安全逻辑(越权检查、CSRF 守卫、登录防爆破)无自动化测试验证。修改可能导致安全退化。

### GAP-07: 无审计覆盖的 API

**位置**: `apps/gateway/src/routes/features.ts`

**问题**: Skill/Knowledge/MCP connector 的 CRUD 操作未写入 `t_dsh_audit_events`。

**影响**: 扩展功能的操作不可审计。

**建议**: 在 P2/P3 阶段补充审计写入。

---

## 3. 架构级安全评估

| 层面 | 状态 | 说明 |
|---|---|---|
| L1 进程与文件系统隔离 | ⚠️ 骨架 | 独立目录已创建,OS 用户隔离未实现 |
| L2 网关 ACL | ✅ 基本 | sid+CSRF 守卫正常;越权404原则部分实现 |
| L3 dsh 组合层 | ⚠️ 骨架 | bridge 插件逻辑就绪,但未经测试 |
| L4 OS 沙箱 | ❌ 未开始 | 设计文档要求的 bwrap/Landlock 未实现 |
| 凭据管理 | ❌ 未开始 | 仅使用 `.env` 注入,无信封加密 |

---

## 4. 安全合规清单

| 要求 | 状态 |
|---|---|
| 密码不以明文存储 | ✅ argon2id |
| 凭据不进版本库 | ✅ .env |
| 凭据不进普通日志 | ⚠️ 需代码审查确认无意外泄漏 |
| Credential 不返回浏览器 | ✅ |
| 越权返回 404 | ⚠️ 部分路由(见 GAP-01) |
| CSRF 覆盖全部写操作 | ✅ |
| 登录防爆破 | ✅ (进程内存) |
| 审计覆盖 | ⚠️ 扩展功能 API 缺失 |