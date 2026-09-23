# REWORK-07 — Platform Memory Data Model Audit

> 审计日期:2026-09-18
> 真源:`db/schema.sql` + `apps/gateway/src/repositories/memory-repository.ts`

---

## 表结构

### t_dsh_memory_records

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | CHAR(36) PK | UUID |
| `tenant_id` | CHAR(36) FK | 租户 |
| `owner_user_id` | CHAR(36) | 所有者 |
| `namespace` | VARCHAR(128) | 命名空间(默认 `default`) |
| `content` | TEXT | 内容 |
| `visibility` | VARCHAR(20) | `personal` / `tenant_shared` |
| `source_type` | VARCHAR(20) | `user_fact` / `model_inferred` / `imported` / `team_approved` |
| `source_session_id` | VARCHAR(128) | 来源会话 |
| `source_event_seq` | BIGINT | 来源事件 seq |
| `confidence` | TINYINT | 1-10 |
| `review_status` | VARCHAR(20) | pending/approved/rejected |
| `reviewed_by` | CHAR(36) | |

### t_dsh_memory_promotions

promote 审计:`memory_id` / `from_visibility` / `to_visibility` / `requested_by` / `status`。

---

## 12 个审计问题

| # | 问题 | 答案 |
|---|------|------|
| 1 | memory row 字段 | 见上表 |
| 2 | namespace 真实语义 | 仅自由文本分组,无 ACL 语义 |
| 3 | personal 是否默认 private | 是(创建固定 `personal`) |
| 4 | team sharing 是否真实 | 部分:有 `tenant_shared` visibility + 查询,但无 per-team ACL |
| 5 | promote 做什么 | `UPDATE visibility`,写 promotion 记录;`member` 不能 promote |
| 6 | 是否有 source/session/provenance | 有 `source_type` / `source_session_id` / `source_event_seq` |
| 7 | 是否有 version/revision | **无**(Phase 07 新增) |
| 8 | delete 是 hard 还是 soft | **hard delete**(Phase 07 改 soft delete) |
| 9 | search 算法 | `LIKE`(Phase 07 增强 lexical scoring) |
| 10 | tags/type/importance/confidence | 仅 `confidence`;无 kind/tags(Phase 07 新增 `kind`) |
| 11 | createdBy/updatedBy | 仅 owner;无 updatedBy(Phase 07 新增) |
| 12 | 哪些字段是 scaffold | `confidence` / `review_status` / `reviewed_by` 基本未使用 |

---

## Phase 07 变更

| 列 | 类型 | 说明 |
|----|------|------|
| `kind` | VARCHAR(20) | `preference` / `fact` / `decision` / `instruction` / `other` |
| `content_hash` | VARCHAR(64) | 去重 |
| `revision` | INT | 版本 |
| `superseded_by` | CHAR(36) | 冲突时旧记录指向新记录 |
| `extraction_mode` | VARCHAR(20) | `manual` / `explicit_user` / `llm` |
| `updated_by` | CHAR(36) | 最后修改者 |
| `deleted_at` | DATETIME(3) | soft delete |

Migration:`db/migrations/007-memory-runtime.sql`。

## 结论

- 现有表可扩展,新增列非破坏
- personal/private 默认满足
- team sharing 保留但 Runtime 默认只投影 personal/private(`TEAM_MEMORY_RUNTIME = DISABLED`)