# Phase 03 — Memory 隔离与治理

> 实现日期:2026-09-16

---

## 1. 架构总览

```text
Portal UI (MemoryView)
    ↓
Gateway API (/api/memory/*)
    ↓
MemoryService (tenant/user filtering)
    ↓
MemoryRepository (MySQL: t_dsh_memory_records)
    ↓
DSH Harness Bridge (future: MCP adapter)
```

---

## 2. 数据模型

### 2.1 t_dsh_memory_records

| 字段 | 类型 | 说明 |
|---|---|---|
| id | CHAR(36) PK | UUID |
| tenant_id | CHAR(36) | 租户隔离基座 |
| owner_user_id | CHAR(36) | 创建者 |
| namespace | VARCHAR(128) | 命名空间(默认 'default') |
| content | TEXT | 记忆内容 |
| visibility | VARCHAR(20) | 'personal' \| 'tenant_shared' |
| source_type | VARCHAR(20) | 'user_fact' \| 'model_inferred' \| 'imported' \| 'team_approved' |
| source_session_id | VARCHAR(128) | 来源会话 ID |
| source_event_seq | BIGINT | 来源事件序号 |
| confidence | TINYINT | AI 推断可信度(1-10) |
| review_status | VARCHAR(20) | 'pending' \| 'approved' \| 'rejected' |
| reviewed_by | CHAR(36) | 审核人 |

索引: `(tenant_id, owner_user_id, visibility)` + `(visibility, tenant_id)`

### 2.2 t_dsh_memory_promotions

审核提升记录,追踪 personal → tenant_shared 的提交流程。

---

## 3. 安全设计

### 3.1 检索前过滤(Key Rule 3)

```text
Tenant / User predicate (SQL WHERE)
        ↓
Keyword search (LIKE)
        ↓
Top K
```

所有 Memory 查询首先在 SQL 层面带 `tenant_id` 和 `owner_user_id`/`visibility` 过滤,杜绝全库扫描后做应用层过滤。

### 3.2 默认 Private(Key Rule 1)

新创建的记忆默认 `visibility = 'personal'`。不会因为同租户而自动共享。

### 3.3 显式 Promote(Key Rule 2)

`POST /api/memory/:id/promote` 要求 `targetVisibility` 显式指定。
`personal → tenant_shared` 需要 `role !== 'member'`(operator 及以上)。

---

## 4. Source of Truth

| 数据 | 真源 | 说明 |
|---|---|---|
| Memory 内容 | `t_dsh_memory_records` (MySQL) | 平台数据库权威 |
| Visibility | MySQL | 检索时以此过滤 |
| Embedding/Vector | 未来:派生数据 | 本阶段不引入向量 DB |
| Harness local state | 消费者 | 不作为权威 |

---

## 5. 修改文件清单

| 文件 | 变更 |
|---|---|
| `packages/shared/src/types.ts` | +Memory 类型定义 |
| `db/schema.sql` | +t_dsh_memory_records, +t_dsh_memory_promotions |
| `apps/gateway/src/repositories/audit-repository.ts` | +memory.create/delete/promote |
| `apps/gateway/src/repositories/memory-repository.ts` | **新建** DB 层 |
| `apps/gateway/src/services/memory-service.ts` | **新建** 业务逻辑 |
| `apps/gateway/src/routes/memory.ts` | **新建** API 路由 |
| `apps/gateway/src/index.ts` | 注册 memory routes + platform API paths |
| `apps/portal/src/memory-view.tsx` | **新建** Memory UI |
| `apps/portal/src/main.tsx` | 引入 MemoryView |
| `apps/gateway/tests/memory-isolation.test.ts` | **新建** 跨租户隔离测试 |

---

## 6. API 规范

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | /api/memory | sid | 搜索记忆(visibility 过滤) |
| POST | /api/memory | sid+CSRF | 创建记忆 |
| GET | /api/memory/:id | sid | 获取单条 |
| DELETE | /api/memory/:id | sid+CSRF | 删除(仅 owner) |
| POST | /api/memory/:id/promote | sid+CSRF | 提升 visibility |
| GET | /api/memory/namespaces | sid | 列出命名空间 |

---

## 7. Exit Gate

```text
[x] 用户 Private Memory 不串            → SQL WHERE owner_user_id = ?
[x] Tenant Shared 需要显式权限           → promote 接口 + role 校验
[x] vector search 在检索阶段带 predicate → MySQL WHERE tenant_id/visibility
[x] Memory Source 可追溯                → source_type + source_session_id
[x] 自动提取有 policy                    → source_type + review_status + pending 审核
[x] Secret 有保护                       → 依赖 Phase 02 安全边界,无额外泄漏路径
[x] cross-tenant tests 通过             → memory-isolation.test.ts
[x] Harness Adapter 不绕过 ACL          → 平台 MemoryService 是唯一入口
```

### 已知限制

- **向量检索**:本阶段使用 MySQL LIKE 关键词搜索。向量数据库(如 pgvector/LanceDB)集成留在后续阶段,前提是所选向量库支持 metadata pre-filter。
- **Harness MCP Bridge**:平台 Memory Service 已建立,Agent 侧 Harness 插件(dsh-memory-bridge)需结合 Phase 06 MCP 体系实现,本阶段未实现。
- **自动提取**:`model_inferred` source_type + `pending` review_status 设计已就绪,但 Agent 端自动注入逻辑待 MCP bridge 接入后完成。