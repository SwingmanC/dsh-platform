# REWORK-05 — Platform Knowledge Data Model Audit

> 审计日期:2026-09-18
> 真源:`db/schema.sql` + `apps/gateway/src/repositories/knowledge-repository.ts`

---

## 表结构

### t_dsh_knowledge_bases

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | CHAR(36) PK | UUID |
| `tenant_id` | CHAR(36) FK | 所属租户 |
| `creator_id` | CHAR(36) FK | 创建者 |
| `name` | VARCHAR(128) | 名称 |
| `description` | TEXT | 描述 |
| `visibility` | VARCHAR(20) | `personal` / `tenant` |
| `doc_count` | INT | 文档计数 |
| `status` | VARCHAR(20) | `active` |

### t_dsh_knowledge_documents

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | CHAR(36) PK | UUID |
| `kb_id` | CHAR(36) FK | 所属 KB |
| `filename` | VARCHAR(256) | 原始文件名(元数据) |
| `filepath` | VARCHAR(1024) | 存储路径 |
| `file_size` | BIGINT | 字节数 |
| `content_type` | VARCHAR(64) | MIME |
| `status` | VARCHAR(20) | `uploaded` / `parsing` / `chunking` / `ready` / `failed` / `archived` |
| `current_version` | INT | 当前版本号 |

### t_dsh_knowledge_document_versions

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | CHAR(36) PK | UUID |
| `doc_id` | CHAR(36) FK | 关联文档 |
| `version` | INT | 版本号 |
| `content` | LONGTEXT | **提取后的文本** |
| `content_hash` | VARCHAR(64) | SHA256 |
| `filepath` | VARCHAR(1024) | 存储路径 |
| `file_size` | BIGINT | 字节数 |

### t_dsh_knowledge_chunks

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | CHAR(36) PK | UUID |
| `doc_id` | CHAR(36) FK | 所属文档 |
| `kb_id` | CHAR(36) FK | 所属 KB |
| `chunk_index` | INT | 顺序号 |
| `content` | TEXT | 分块文本 |
| `token_count` | INT | 可选 token 数 |

### t_dsh_knowledge_ingestion_jobs

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | CHAR(36) PK | UUID |
| `kb_id` | CHAR(36) FK | 所属 KB |
| `doc_id` | CHAR(36) | 所属文档 |
| `source_type` | VARCHAR(20) | `upload` / `url` |
| `status` | VARCHAR(20) | `pending` / `parsing` / `chunking` / `ready` / `failed` |
| `error_message` | TEXT | 错误信息 |

### t_dsh_knowledge_mounts

| 列 | 类型 | 说明 |
|----|------|------|
| `user_id` | CHAR(36) | 挂载用户 |
| `kb_id` | CHAR(36) FK | 挂载的 KB |
| `mount_type` | VARCHAR(20) | `user` / `session` / `workspace` |

---

## 12 个审计问题

| # | 问题 | 答案 |
|---|------|------|
| 1 | KB tenant/owner/visibility 语义 | tenant_id 归属;creator_id 所有者;personal 仅创建者可见,tenant 同租户可见 |
| 2 | personal/team/public 支持 | 当前仅 `personal` / `tenant`;无 `public` |
| 3 | mount 真实作用域 | **user 级**(`mount_type='user'`, `user_id 过滤`) |
| 4 | document 表是否存在 | 存在且有业务 writes(`addDocument`) |
| 5 | document_versions schema | 存在且有 content/content_hash/filepath 字段 |
| 6 | knowledge_chunks 当前状态 | 有 schema 和 `addChunks` repository 方法 |
| 7 | ingestion_jobs 状态字段 | `pending` / `parsing` / `chunking` / `ready` / `failed` |
| 8 | chunk 元数据 | 有 `doc_id` / `kb_id` / `chunk_index` / `content` / `token_count`,无 `sourceOffset` / `page` |
| 9 | 搜索 API 为何返回 empty | 因为 `addChunks` 未被业务调用;chunks 表为空 |
| 10 | 删除级联策略 | `ON DELETE CASCADE` 在 FK 约束上 |
| 11 | team ACL 是否真实实现 | 否;仅 creator 可见性 + tenant 级 filtering |
| 12 | 哪些表有结构无业务 writes | `t_dsh_knowledge_ingestion_jobs` 有 schema 但无业务 insert;`document_versions` 有 schema 但无业务 insert |

---

## 结论

- Schema 已基本就绪
- Document versions 表需要业务 writes(当前已存在但无数据)
- Ingestion jobs 需要业务 writes
- Chunks 需要真实业务 writes
- 上传 endpoint 需要实现
- 存储路径方案需要实现