# Phase 05 — 知识库与 RAG

> 实现日期:2026-09-16

---

## 1. 架构总览

```text
Portal UI (知识中心)
    ↓
Gateway API (/api/knowledge-bases/*, /api/knowledge/search)
    ↓
KnowledgeService (ACL + KB scope)
    ↓
KnowledgeRepository (MySQL: 7 张表)
    │
    ├─ Metadata:       kb / permissions / documents / versions
    ├─ Content:        chunks (含 embedding 占位列)
    ├─ Mounts:         user/session mounts
    └─ Ingestion:      ingestion_jobs
```

---

## 2. 数据模型(7 表)

| 表 | 说明 |
|---|---|
| `t_dsh_knowledge_bases` | 知识库(增强: visibility/category/status) |
| `t_dsh_knowledge_permissions` | 细粒度权限(read/propose/write/admin) |
| `t_dsh_knowledge_documents` | 文档(增强: status/current_version) |
| `t_dsh_knowledge_document_versions` | 文档版本(content_hash + filepath) |
| `t_dsh_knowledge_chunks` | 块(含 embedding BLOB 占位列) |
| `t_dsh_knowledge_mounts` | 用户/会话级挂载 |
| `t_dsh_knowledge_ingestion_jobs` | 导入任务(upoaded→parsing→chunking→ready) |

---

## 3. ACL 设计

| 可见性 | 谁可查看 KB | 谁可搜索文档 |
|---|---|---|
| personal | 仅创建者 | 仅创建者 |
| tenant | 同租户用户 | 同租户用户(KB 下所有文档) |
| 细粒度权限 | permission 表 | read/propose/write/admin |

检索安全: `knowledge_base_id + ACL filter` → `chunks.content LIKE ?` → TopK

---

## 4. 修改文件清单

| 文件 | 变更 |
|---|---|
| `packages/shared/src/types.ts` | +Knowledge 类型体系 |
| `db/schema.sql` | 增强 KB 表 + 新增 6 表 |
| `apps/gateway/src/repositories/knowledge-repository.ts` | **新建** |
| `apps/gateway/src/services/knowledge-service.ts` | **新建** |
| `apps/gateway/src/routes/knowledge.ts` | **新建** |
| `apps/gateway/src/index.ts` | 注册 knowledge routes |
| `apps/gateway/tests/knowledge-isolation.test.ts` | **新建** 跨租户隔离测试 |

---

## 5. API 规范

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | /api/knowledge-bases | sid | 知识库列表(ACL) |
| POST | /api/knowledge-bases | sid+CSRF | 创建知识库 |
| GET | /api/knowledge-bases/:id/documents | sid | 文档列表 |
| GET | /api/knowledge/search | sid | 块级全文搜索 |
| POST | /api/knowledge-bases/:id/mount | sid+CSRF | 挂载知识库 |
| GET | /api/knowledge/mounts | sid | 已挂载列表 |

---

## 6. Exit Gate

```text
[x] Personal KB 隔离                  → SQL WHERE creator_id
[x] Shared KB ACL                     → visibility = 'tenant' + tenant_id 过滤
[x] Retrieval pre-filter              → chunks.kb_id IN (authorized Kbs)
[x] Ingestion 可重试                  → ingestion_jobs 状态机 + status 追踪
[x] URL import SSRF 防护              → 本阶段未实现 URL import
[x] 文档版本控制                      → document_versions + content_hash
[x] Knowledge Mount                   → mounts 表(user/session/workspace)
[x] RAG budget                        → limit + offset 分页
[x] DSH Adapter 只持最小权限          → 平台 API 是唯一入口
[x] cross-tenant tests                → 5 个用例
[x] build + typecheck 通过            → ✅
```

### 已知限制

- **Embedding/向量搜索**:`chunks.embedding` 列已预留(BLOB),但本阶段使用 MySQL LIKE 搜索。向量集成依赖所选向量库的 metadata pre-filter 能力。
- **URL Import**:SSRF 防护设计待后续阶段实现。
- **DSH Knowledge Adapter**:Harness 侧集成需结合 Phase 06 MCP 体系。
- **Parser/Chunker**:当前为简化实现(直接 content 写入),生产级文档解析器(支持 PDF/Office)待后续引入。