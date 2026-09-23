# Phase 01 — Current Architecture Audit

> 审计日期:2026-09-16 | 审计人: Coding Agent

---

## 1. 项目概要

| 属性 | 值 |
|---|---|
| 名称 | `dsh-platform` |
| 版本 | `0.1.0` |
| 形态 | Fastify 网关 + Vite/React Portal SPA + 每用户 dsh Runtime |
| Node.js | ≥ 22 |
| pnpm | ≥ 10 |
| 包管理 | pnpm workspace, `autoInstallPeers: false` |
| 模块系统 | ESM (`"type": "module"`) |
| TypeScript | `strict` + `noImplicitAny` + `noUncheckedIndexedAccess` |

---

## 2. 目录结构

```
apps/
  gateway/     Fastify 网关:认证(sid cookie)、反代、Supervisor、MySQL
  portal/      Vite + React SPA:登录页、历史会话/工作区、迁移弹窗
packages/
  shared/      跨端共享类型:表实体镜像与 DTO
  sdk-driver/  每用户 dsh 运行时驱动(骨架,方法体均 throw TODO)
  dsh-bridge/  Cordis 插件对:platform-identity(Host) + ui-platform-account(Client)
  skill-plaza/ 技能广场 client bundle(侧栏按钮 + 技能 CRUD modal)
  knowledge-base/ 知识库 client bundle(侧栏按钮 + 知识库 CRUD modal)
  connector/   MCP 连接器 client bundle(侧栏按钮 + 连接器 CRUD modal)
db/
  schema.sql   dsh_platform 库 DDL(10 张业务表 + 2 张预留表)
docs/
  design/
    MULTI-TENANT-DEPLOYMENT-PLAN.zh-CN.md   (426 行,总方案)
    platform-user-binding-design.zh.md        (352 行,P1 具体化)
```

---

## 3. 架构总览

```text
浏览器
  │
  ▼
Gateway (Fastify :8080)
  │  /auth/login|logout|me          ← 认证(sid cookie + CSRF)
  │  /api/workspaces|sessions|...   ← 平台 API
  │  /api/skills|knowledge-bases|connectors  ← 扩展功能 API
  │  /  (dsh UI authority)          ← 反代到该用户实例
  │
  ├── MySQL(dsh_platform)
  │     t_dsh_tenants / t_dsh_users / t_dsh_workspaces
  │     t_dsh_agent_bindings / t_dsh_runtimes
  │     t_dsh_provider_credentials / t_dsh_quotas / t_dsh_usage_counters
  │     t_dsh_sync_cursors / t_dsh_audit_events
  │     t_dsh_skills / t_dsh_skill_installations  (预留)
  │     t_dsh_knowledge_bases / t_dsh_kb_documents  (预留)
  │     t_dsh_mcp_connectors  (预留)
  │
  └── Per-User dsh Runtime (子进程)
       独立 DSH_HOME / 独立 workspace / 独立 env
       --trusted-host <DSH_UI_AUTHORITY>
```

### 3.1 认证模型

- sid cookie(HttpOnly, SameSite=Lax) 作为会话标识
- CSRF 双提交:csrf_token cookie + x-csrf-token header
- 支持 Redis 会话存储,默认降级为进程内存
- 登录防爆破:按 email+IP 计失败次数
- 密码:argon2id

### 3.2 Supervisor 模型

- `ensureRuntime(userId)`: 复用 ready 实例或拉起新进程
- `drainRuntime(userId)`: 优雅排空(标记 draining → kill → 清注册表)
- `startIdleReaper()`: 空闲回收巡检(默认 30min TTL)
- `shutdownRuntimes()`: 网关关闭时清理

### 3.3 代理模型

- dsh 0.1.1-rc.2 前端使用根绝对路径,无法挂子路径
- 故 dsh UI 挂在专属 authority(DSH_UI_AUTHORITY),网关按 Host 路由
- 覆写 Host header 为 uiAuthority 以通过 dsh 围栏

---

## 4. 设计文档 vs 代码实现一致性

| 设计文档要求 | 代码状态 | 结论 |
|---|---|---|
| per-user dsh Runtime | Supervisor 已实现,`ensureRuntime` 工作 | ✅ 一致 |
| sid cookie + CSRF | `session.ts` + 全局 preHandler | ✅ 一致 |
| 登录防爆破 | `login-guard.ts` (进程内存) | ✅ 一致 |
| argon2id 密码 | `password.ts` | ✅ 一致 |
| `t_dsh_agent_bindings` 含 `workspace_id`/`migrated_from` | schema.sql 已含,已折叠进 CREATE | ✅ 一致 |
| launch-token 交换(设计文档 §3.2) | 当前未实现:0.1.1-rc.2 无 launch token | ⚠️ 版本差异,README 已说明 |
| `/app/*` 子路径代理 | 改为专属 authority 路由 | ⚠️ 版本差异,README 已说明 |
| SDK 会话创建(design T2 → T4) | `sdk-driver` 方法体均 throw TODO | ⚠️ 骨架阶段 |
| S2 迁移 (`POST /api/sessions/migrate`) | 返回 501 | ⚠️ 未实现 |
| 凭据解密注入 | `supervisor.ts:93` 有 TODO 注释 | ⚠️ 未实现 |
| 平台 Home/Workspace 路径含 tenant 层级 | 当前 `homes/<userId>`,设计为 `homes/<tenant>/<user>` | ⚠️ 设计差异 |

---

## 5. 关键依赖版本

| 包名 | 版本 | 来源 |
|---|---|---|
| dsh (实际安装) | `0.1.1-rc.2` | README / config.ts |
| @deepseek-ai/dsh (peer) | `0.1.2-rc.1` | sdk-driver package.json |
| @deepseek-ai/dsh-sdk-client (peer) | `0.1.2-rc.1` | sdk-driver package.json |
| @deepseek-ai/dsh-sdk-protocol (peer) | `0.1.2-rc.1` | sdk-driver package.json |
| @deepseek-ai/cordis | `4.0.2` | dsh-bridge package.json(dep) |
| @deepseek-ai/dsh-api-remotes | `0.1.1-rc.2` | dsh-bridge package.json(dep) |
| @deepseek-ai/dsh-client-runtime | `0.1.1-rc.2` | dsh-bridge package.json(dep) |
| @deepseek-ai/dsh-client-ui-* | `0.1.1-rc.2` | dsh-bridge package.json(dep) |
| @deepseek-ai/dsh-session | `0.1.1-rc.2` | dsh-bridge package.json(dep) |
| @deepseek-ai/dsh-typert-protocol | `0.1.1-rc.2` | dsh-bridge package.json(dep) |

**关键发现**: peerDependencies 锁定 `0.1.2-rc.1`,但实际安装的 dsh + dsh-bridge 依赖均为 `0.1.1-rc.2`。这是已知设计差异。

---

## 6. 代码健康度

| 检查项 | 状态 |
|---|---|
| `pnpm build` | ✅ 全部通过 |
| `pnpm typecheck` | ✅ 全部通过 |
| 单元测试 | ❌ 无任何测试文件 |
| e2e 测试 | ❌ 未开始(T5) |
| lint | ❌ 未配置 ESLint/Prettier |
| CI | ❌ 无 CI 配置 |

---

## 7. 现有代码质量观察

### 7.1 良好实践
- 所有密码/密钥只经环境变量注入
- CSRF 双提交守卫覆盖所有 `/api/*` 写操作
- 越权资源返回 404 原则已在部分路由实现
- 审计落库失败不阻断业务
- 清晰的模块分离(gateway/portal/shared)

### 7.2 需改进项
- `features.ts`: DELETE skill/connector 返回 403 而非 404(违反设计文档约定)
- `features.ts`: skills/knowledge/connectors 列表查询使用 `tenant_id = (SELECT ...)` 子查询,效率可优化
- `session-sync.ts:65`: hardcoded `host: 'localhost:8080'`
- `dsh-bridge` src 与 bundle 分离: `src/client.ts` 与 `client.bundle.js` 不同步,src 是占位符
- 三个 feature 包(skill-plaza/knowledge-base/connector)的 src 均为占位符,bundle 是手写产物
- 无任何测试覆盖

---

## 8. Source of Truth 定义

| 数据域 | Source of Truth | 位置 | 说明 |
|---|---|---|---|
| Authentication | 平台 sid Session | Redis/进程内存(`SessionService`) | 网关签发和校验 |
| Tenant | `t_dsh_tenants` (MySQL) | `db/schema.sql` | 平台 CRUD 管理 |
| User | `t_dsh_users` (MySQL) | `db/schema.sql` | 归属单一租户 |
| Session Ownership | `t_dsh_agent_bindings` (MySQL) | `db/schema.sql` | session_id ↔ user_id 映射 |
| Workspace | `t_dsh_workspaces` (MySQL) + 文件系统 | `db/schema.sql` + `platform.ts` | 登记表作索引,文件系统作存在性真源 |
| Memory | dsh JSONL 日志 (每用户 `$DSH_HOME`) | — | 未来 Phase 03 确定 |
| Skill Metadata | `t_dsh_skills` (MySQL) | `schema.sql` (预留表) | 平台登记 |
| Skill Runtime | dsh 实例内的 `ctx.skills` | — | 未来 Phase 04 确定 |
| Knowledge | `t_dsh_knowledge_bases` + `t_dsh_kb_documents` (MySQL) + 文件存储 | `schema.sql` (预留表) | 未来 Phase 05 确定 |
| MCP Registry | `t_dsh_mcp_connectors` (MySQL) | `schema.sql` (预留表) | 未来 Phase 06 确定 |
| Credential | `t_dsh_provider_credentials` (MySQL, 信封加密) | `schema.sql` | 进程运行时解密注入 env |
| Runtime | `t_dsh_runtimes` (MySQL) + 进程注册表 | `schema.sql` + `supervisor.ts` | 数据库持久化,进程注册表作运行时快照 |

### 核心原则

**平台数据库(MySQL `dsh_platform`)是权威真源,`$DSH_HOME` 是派生数据。**

- 用户/租户/绑定关系 → MySQL 唯一真源
- 会话事件日志 → `$DSH_HOME` JSONL 唯一真源(平台不重复存储)
- 工作区存在性 → 文件系统真源,MySQL 作巡检缓存
- `t_dsh_agent_bindings` 不是授权路径——鉴权走 sid session,绑定记录只用于审计和迁移追溯