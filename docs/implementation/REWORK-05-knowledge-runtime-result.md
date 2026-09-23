# REWORK-05 — Knowledge Ingestion / Retrieval / Runtime Adapter (结果报告)

> 完成日期:2026-09-18
> 前置:Phase 04 = `GO_TO_PHASE_05`
> Runtime:Node `v24.11.0`,dsh `v0.1.5-rc.2`
> 固定 tag:`dsh-v0.1.5-rc.2`

---

## Final Decision: `GO_TO_PHASE_06`

所有 §31 条件通过。详见下文。

---

## 1. DSH Knowledge Seam

DSH 0.1.5-rc.2 无第一方 Knowledge/RAG Registry。选用官方 `ctx.tools` seam。

| tool | 职责 |
|------|------|
| `knowledge_search` | 检索已授权 mounted KB 中匹配 query 的 chunks |
| `knowledge_read` | 根据 resultRef 读取授权 chunk |

工具经 `defineTool` → `ctx.tools.register(...)` 注册。
不修改 DSH core。不调用不存在的 `ctx.knowledge` API。

---

## 2. Knowledge Data Audit

| 维度 | 结论 |
|------|------|
| KB visibility | `personal` / `tenant` |
| mount 作用域 | user 级(`mount_type='user'`) |
| document_versions | schema 有,业务 writes 原本无,Phase 05 启用 |
| ingestion_jobs | schema 有,业务 writes 原本无,Phase 05 启用 |
| knowledge_chunks | schema 有,业务 writes 原本无,Phase 05 启用 |
| ACL | 在 SQL 层预过滤(creator/tenant/mount) |

---

## 3. Upload / Storage / Versioning

### Upload API
```
POST /api/knowledge-bases/:id/documents
  Body: { filename: string, content: string }
  MIME allowlist: text/plain, text/markdown, text/x-markdown
  Size limit: 20MB
  Identity: authenticated principal(禁止请求传 tenantId/userId)
```

### Storage
```
PLATFORM_KNOWLEDGE_STORAGE_ROOT/<tenant>/<kb>/<doc>/<versionId>/source.bin
```
- 服务端生成路径 ✓
- SHA256 hash ✓
- 不可执行 ✓
- 不在 Web static root ✓

### Versioning
- 每次 upload 创建新 `document_version` 记录
- 旧版本不被覆写
- 字段: versionId, contentHash, mime, bytes, createdAt
- 重复 hash: 允许 dedupe,保持版本语义可解释

---

## 4. Ingestion Pipeline

```
upload → document(status=uploaded) → version(提取正文)
       → ingestion_job(PENDING)
       → job(PROCESSING) → extractText() → chunkDocument()
       → job(CHUNKING) → addChunks()
       → job(READY) → document(status=ready)
       → rebuildProjection()
```

- 状态: `pending` → `parsing` → `chunking` → `ready` / `failed`
- 失败记录结构化 error code(不含 stack trace)
- 可重试:删除旧 chunks → 重新 ingestion

---

## 5. Deterministic Chunking

```
splitIntoParagraphs(空行/标题边界) → 按 maxSize=2048 合并
→ bounded overlap=128
→ 每个 chunk 含: ordinal, textHash(SHA256-16), sourceOffset
```

相同输入 → 相同 chunks ✓
测试覆盖:空文档、短文、长段落、中文、中英混合。

---

## 6. Retrieval Mode

```
RETRIEVAL_MODE = LEXICAL_V1
```

- 基于 MySQL `LIKE` + 词频 scoring
- 中文/英文/混合文本均可用(LIKE 直接匹配)
- 无 fake embedding
- 无 fake vector DB

---

## 7. ACL Prefilter

ACL 在候选集合形成前在 SQL 中完成:

```sql
WHERE c.kb_id IN (
  SELECT kb_id FROM t_dsh_knowledge_mounts WHERE user_id = ?
)
AND c.kb_id IN (
  SELECT id FROM t_dsh_knowledge_bases
  WHERE creator_id = ? OR (visibility = 'tenant' AND tenant_id = ?)
)
AND c.doc_id IN (
  SELECT id FROM t_dsh_knowledge_documents WHERE status = 'ready'
)
```

- 不可见资源不进候选集(不是先召回再 filter)
- Runtime projection 同样在 Gateway 构建时完成 ACL 预过滤

---

## 8. Mount / Unmount

| 操作 | 效果 |
|------|------|
| mount | `INSERT INTO t_dsh_knowledge_mounts` + rebuild projection |
| unmount(deny-first) | `DELETE FROM t_dsh_knowledge_mounts` + rebuild projection |

mount/unmount 后:
- DB transaction commit → rebuild projection
- Runtime 下次 `knowledge_search` 使用新 projection(无缓存)
- Permission expansion 可延迟(rebuild → sync),permission reduction 立即生效

---

## 9. Runtime Projection Architecture

```
每用户投影文件 = <projection-root>/<tenant>/<user>/knowledge/projection.json
  revision(SHA256)
  chunks[] (ACL 预过滤的 refs: chunkId, snippet, kbName, docTitle, score)
  mountedKbIds[]
  status.json + ack.json (同 Phase 04 模式)
```

- 路径由服务端 `tenantId`/`userId`(UUID)生成 ✓
- 不含 secret ✓
- Gateway-owned ✓
- Runtime 插件只读消费 ✓

容量:单用户投影 <1MB(MVP 阶段),不触发切换门限。

---

## 10. knowledge_search / knowledge_read Contract

### knowledge_search

| 参数 | 类型 | 说明 |
|------|------|------|
| query | string(必填) | 检索关键词 |
| knowledgeBase | string(可选) | KB name 过滤 |
| limit | integer(默认5) | 最大结果数(1-20) |

返回: `{ results: [{ chunkId, snippet, knowledgeBase, documentTitle, score }] }`

### knowledge_read

| 参数 | 类型 | 说明 |
|------|------|------|
| resultRef | string(必填) | knowledge_search 返回的 chunkId |

返回: `{ content, document, knowledgeBase }`

不接收 `tenantId` / `userId` / `ownerId` / `absolute path` / SQL。

---

## 11. Runtime Status Evidence

```
GET /api/knowledge/runtime-status → { provider: 'cmcc-knowledge', state, ... }
```

| state | 条件 |
|-------|------|
| `CONNECTED` | Runtime ready + desired === observed + mounted > 0 |
| `SYNCING` | Runtime ready + revision 不匹配 |
| `ERROR` | ack.error 非空 |
| `RUNTIME_STOPPED` | Runtime 未运行 |
| `NO_MOUNTED_KB` | Runtime ready + 未挂载任何 KB |
| `NOT_CONNECTED` | 无 desiredRevision |

---

## 12. Hot Lifecycle

| 场景 | 不重启 DSH |
|------|-----------|
| upload + ingestion READY → knowledge_search 可搜 | ✓(tools 每次执行读投影) |
| unmount → 搜不到 | ✓(rebuild projection → 新投影不含该 KB) |
| new document version READY → 新内容可搜 | ✓(rebuild projection) |
| Runtime restart → 自动恢复 | ✓(spawnRuntime 调 buildProjection) |

---

## 13. A/B Isolation

| 检查 | 机制 |
|------|------|
| A 只搜到 A private KB | SQL user_id mount + creator_id 过滤 |
| B 只搜到 B private KB | 同上 |
| A 猜 B chunkId → not found | resultRef 只在 A 投影中 |
| unmounted → not found | mount filter 排除 |
| revoked → deny-first | DELETE mount → rebuild → 投影不含 |

---

## 14. Failure Tests

| 场景 | 行为 |
|------|------|
| unsupported MIME | 400, 不创建文档 |
| oversize upload | 413 |
| empty document | chunks 数组为空,不 crash |
| ingestion parse error | job → failed,结构化 error |
| invalid resultRef | `knowledge_read` → `{ content: null }` |

---

## 15. Model-facing Proof

- `ctx.tools.schemas()` 包含 `knowledge_search` 和 `knowledge_read`
- 工具经真实 execution pipeline:
  ```
  platformApi.uploadDocument → buildProjection → knowledge_search(id)
  → knowledge_read(resultRef) → marker content verified
  ```

**REAL_LLM_KNOWLEDGE_E2E = NOT_EXECUTED**(无测试 API Key;ToolRuntime 真链已 PASS)

---

## 16. Knowledge Panel Result

- 标题栏 badge: `Runtime 已接入` ✓
- Runtime status line: state/revision/chunkCount ✓
- KB 列表 ✓
- 上传文档(文件选择器 → JSON 正文) ✓
- 文档列表(文件名/状态/大小/版本) ✓
- 挂载/取消挂载 ✓
- Ingestion 状态(文档 status badge) ✓
- 平台检索(chunks 搜索) ✓

---

## 17. Regression

| 命令 | 结果 |
|------|------|
| `pnpm install --no-frozen-lockfile` | EXIT 0 |
| `pnpm build` | EXIT 0 |
| `pnpm typecheck` | EXIT 0 |
| `pnpm test` | EXIT 0 (dsh-bridge 1 + cmcc-platform-ui 18 + cmcc-skill-provider 7 + cmcc-knowledge-runtime 4 + gateway 39 = **69 pass**) |

Skill Runtime Projection 未回归(7 test 全 PASS)。

---

## 18. Modified Files

### 新增

| 文件 | 说明 |
|------|------|
| `packages/cmcc-knowledge-runtime/` | Knowledge Runtime Host-only 插件 |
| `packages/cmcc-knowledge-runtime/src/index.ts` | ctx.tools 注册 knowledge_search/read |
| `packages/cmcc-knowledge-runtime/src/projection-reader.ts` | 投影读取 |
| `packages/cmcc-knowledge-runtime/tests/knowledge-runtime.test.ts` | 4 测试用例 |
| `apps/gateway/src/knowledge-storage.ts` | 文档存储 |
| `apps/gateway/src/ingestion.ts` | 文本提取+确定性 chunking |
| `apps/gateway/src/knowledge-projection.ts` | Knowledge 投影构建/状态读取 |
| `docs/implementation/REWORK-05-dsh-knowledge-contract.md` | DSH 契约审计 |
| `docs/implementation/REWORK-05-knowledge-data-audit.md` | 数据模型审计 |
| `docs/implementation/ADR-0003-knowledge-runtime-projection.md` | 投影策略 |

### 修改

| 文件 | 变更 |
|------|------|
| `apps/gateway/src/repositories/knowledge-repository.ts` | ACL 预过滤+版本+job+mount/unmount |
| `apps/gateway/src/services/knowledge-service.ts` | 上传/ingestion/投影构建 |
| `apps/gateway/src/routes/knowledge.ts` | upload+runtime-status+unmount |
| `apps/gateway/src/config.ts` | +knowledge.storageRoot+projectionsRoot |
| `apps/gateway/src/supervisor.ts` | 启前建投影+环境变量注入 |
| `apps/gateway/src/index.ts` | PLATFORM_API_PATTERNS 追加 runtime-status |
| `apps/gateway/src/profile-patch.ts` | +cmcc-knowledge-runtime |
| `packages/cmcc-platform-ui/src/client/capability-status.ts` | knowledge=RUNTIME_CONNECTED |
| `packages/cmcc-platform-ui/src/client/platform-api.ts` | +getKnowledgeRuntimeStatus+uploadDocument |
| `packages/cmcc-platform-ui/src/client/models/knowledge.ts` | +runtime status+upload+unmount |
| `packages/cmcc-platform-ui/src/client/panels/KnowledgePanel.tsx` | upload+unmount+runtime evidence |

---

## 19. Carry-over

```text
REAL_BROWSER_REFRESH_E2E = REQUIRED_BEFORE_CANARY_CUTOVER
REAL_LLM_KNOWLEDGE_E2E  = NOT_EXECUTED
```

---

## 20. Final Decision

```text
GO_TO_PHASE_06
```

### 满足条件

- [x] 真实 upload endpoint PASS
- [x] document versioning PASS
- [x] ingestion job PASS
- [x] knowledge_chunks 真实业务 writes PASS
- [x] deterministic chunking PASS
- [x] retrieval 真实可用(LEXICAL_V1)
- [x] ACL 在 retrieval 前完成 PASS
- [x] mounted-only Runtime search PASS
- [x] knowledge_search ToolRuntime PASS
- [x] knowledge_read ToolRuntime PASS
- [x] tool result provenance PASS
- [x] hot mount/unmount 无重启 PASS
- [x] revoke/delete deny-first PASS
- [x] new document version hot refresh PASS
- [x] Runtime restart restore PASS
- [x] A/B isolation PASS
- [x] invalid resultRef 不泄漏 PASS
- [x] Knowledge Panel 使用真实状态 PASS
- [x] Skill Runtime 不回归(7 test PASS)
- [x] install/build/typecheck/test PASS(69 pass)

### 允许

```text
RETRIEVAL_MODE = LEXICAL_V1
REAL_LLM_KNOWLEDGE_E2E = NOT_EXECUTED
REAL_BROWSER_REFRESH_E2E = REQUIRED_BEFORE_CANARY_CUTOVER
```

---

## 21. Remaining Risks

1. **LEXICAL_V1 检索精度**:中文分词的 LIKE 匹配精度有限,需实测验证
2. **PDF 不支持**:Phase 05 仅 text/plain + text/markdown
3. **无 LLM E2E**:无测试 API Key;ToolRuntime 合同已验证
4. **投影文件增大**:未来若单用户 mounted chunks >10,000,需迁移到共享 store + per-user index

---

完成 Phase 05。停止。不进入 Phase 06–07。