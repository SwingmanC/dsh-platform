# Phase 02 — Identity & Runtime Implementation

> 实现日期:2026-09-16

---

## 1. 修改概要

| 分类 | 文件 | 变更说明 |
|---|---|---|
| **新增类型** | `packages/shared/src/types.ts` | 新增 `AuthenticatedPrincipal` + `TenantContext` 接口 |
| **Fastify 声明** | `apps/gateway/src/fastify.d.ts` | 替换 `platformSession` 为 `principal?: AuthenticatedPrincipal` |
| **Session 加固** | `apps/gateway/src/auth/session-store.ts` | SessionStore 接口新增 `rotate`/`revokeByUser` 方法;修复变量名冲突 |
| **Session 服务** | `apps/gateway/src/auth/session.ts` | 新增 `buildPrincipal`/`readPrincipal` 方法;`verifyCsrf` 签名为纯 string |
| **认证中间件** | `apps/gateway/src/index.ts` | preHandler 注入 `request.principal`,不再使用 `platformSession` |
| **Auth 路由** | `apps/gateway/src/routes/auth.ts` | 使用 `readPrincipal` + `auditRepository` |
| **Platform 路由** | `apps/gateway/src/routes/platform.ts` | 全部改用 `request.principal` + Repository 层 |
| **Feature 路由** | `apps/gateway/src/routes/features.ts` | 全部改用 `request.principal`;修复 GAP-01(403→404) |
| **Proxy** | `apps/gateway/src/proxy.ts` | 使用 `auditRepository` 替代旧 `audit` |
| **Repository 层** | `apps/gateway/src/repositories/` | 新建 4 个 repository: workspace/binding/runtime/audit |
| **审计** | `apps/gateway/src/repositories/audit-repository.ts` | 新增 `AuditRepository`, 含完整动作类型 |
| **Runtime 隔离** | `apps/gateway/src/supervisor.ts` | 路径改为 `homes/<tenantId>/<userId>` 和 `workspaces/<tenantId>/<userId>` |
| **Portal 品牌** | `apps/portal/src/main.tsx` | "中国移动 · dsh" → "中国移动 · 数智智能体平台" |
| **GAP-04 修复** | `apps/gateway/src/session-sync.ts` | 硬编码 `localhost:8080` → `config.dsh.uiAuthority` |
| **测试** | `apps/gateway/tests/path-security.test.ts` | 新增路径安全测试(isWithinUserRoot + sanitizeWorkspaceName) |

---

## 2. 安全边界变更

### 2.1 AuthenticatedPrincipal 注入流

```text
请求 → preHandler
         ↓
  sessions.readPrincipal(req)
         ↓
  { principal: AuthenticatedPrincipal, csrfSecret: string }
         ↓
  req.principal = principal
         ↓
  handler 使用 req.principal 决定身份
```

### 2.2 禁止行为

所有 handler 不得从以下来源读取 userId:

- `req.body.userId`
- `req.query.userId`
- `req.headers['x-user-id']`

### 2.3 TenantContext 传递

Repository 方法显式接受 `TenantContext`,确保 SQL WHERE 子句始终包含 `user_id = ?` 和(或)`tenant_id = ?`。

---

## 3. 修复的安全缺口

| ID | 描述 | 修复方式 |
|---|---|---|
| GAP-01 | feature DELETE 返回 403(可探测资源存在性) | 改为统一 404 |
| GAP-04 | session-sync.ts 硬编码 `localhost:8080` | 改为 `config.dsh.uiAuthority` |

---

## 4. 目录结构变更

```text
apps/gateway/
  src/
    repositories/
      workspace-repository.ts   新建
      binding-repository.ts     新建
      runtime-repository.ts     新建
      audit-repository.ts       新建
  tests/
    path-security.test.ts       新建
```

---

## 5. 已知风险

1. **路径变更**:Runtime home/workspace 路径从 `homes/<userId>` 改为 `homes/<tenantId>/<userId>`。存量开发环境中的 `var/homes/` 目录需手动迁移。
2. **旧 audit.ts**:旧文件仍在源码树中(不再被引用),可安全删除。
3. **Redis revokeByUser**:Redis 版暂为桩实现,生产部署需配合 `user->sids` 索引表。