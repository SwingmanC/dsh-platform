# ADR-0003 — Knowledge Runtime Projection Strategy

> 状态:已实现
> 日期:2026-09-18
> 关联:Phase 05 Knowledge Runtime Adapter

---

## 背景

Knowledge 投影可能比 Skill 大很多(每个文档产生多个 chunks)。需要评估容量并选择投影策略。

## 容量评估

| 规模 | docs | chunks(约) | 投影 bytes(约) | rebuild 时间 |
|------|------|------------|----------------|-------------|
| 10 docs | 10 | 500 | ~150 KB | <100ms |
| 100 docs | 100 | 5,000 | ~1.5 MB | <500ms |
| 1,000 docs | 1,000 | 50,000 | ~15 MB | ~2s |
| 10,000 docs | 10,000 | 500,000 | ~150 MB | ~20s |

当前平台场景:单用户 mounted KB 中的 ready chunks 数量在 MVP 阶段远小于 10,000。因此:

**Phase 05 采用"每用户完整 chunk refs"投影策略。**

## 决策

```
每用户投影文件 = <projection-root>/<tenant>/<user>/knowledge/projection.json
包含:
  - revision(SHA256)
  - 该用户所有已 mount + ACL 可见 + ready chunks 的 refs
  - mountedKbIds 列表
```

### 原因

1. 全量 ref 投影(vs 共享 chunk store + per-user index):实现简单,ACL 在 Gateway 构建时预过滤
2. Runtime 插件只读一个 JSON 文件,无额外 SQLite 依赖
3. 投影文件小(仅含 snippet,不含全文),ref 数受 mount 范围限制
4. Gateway 在 mount/unmount/upload/ingestion 后只 rebuild 受影响的单用户投影

### 未来容量门限

如果单个投影文件超过 50MB 或 rebuild 超过 5s,应切换到:
```
shared immutable chunk store
+ per-user ACL/mount index
```
但 Phase 05 不实现该切换。

## 安全约束

- 路径由服务端 `tenantId`/`userId`(UUID)生成
- 投影文件不含 secret/cookie/token
- Runtime 插件只读投影文件,不直接访问 DB
- Chunk refs 已在 Gateway 侧完成 ACL 预过滤:

```sql
WHERE ... (creator_id = ? OR visibility = 'tenant')
  AND user_id = ? (mounted)
  AND status = 'ready'
```

- Runtime `knowledge_read(resultRef)` 只接受投影中存在的 chunkId