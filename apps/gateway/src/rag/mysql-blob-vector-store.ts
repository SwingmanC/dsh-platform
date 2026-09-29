/**
 * K-T6-lite:VectorStore 的 V1 实现(方案 A,K-T4 决策)。
 *
 * - 存储:现有 `t_dsh_knowledge_chunks.embedding BLOB`(Float32 小端编码),不新增表/库。
 * - upsert:仅当 chunk 存在且 kb 属于目标 tenant 时生效(跨租户/不存在 → 拒绝)。
 * - deleteByDocument:embedding = NULL(保留 chunk 本身,维持现有生命周期语义)。
 * - search:候选 SQL 限定 scope.allowedChunkIds(ACL 由 Knowledge Service 预计算,
 *   本类不做权限判断)且 embedding IS NOT NULL;解码后网关内精确 cosine,排序取 topK。
 */
import type { SqlValue } from '../db.js'
import { execute, queryMany } from '../db.js'
import {
  cosineSimilarity, decodeFloat32Vector, encodeFloat32Vector,
} from './vector-store.js'
import type { VectorSearchResult, VectorStore, VectorSearchScope, VectorUpsertItem } from './vector-store.js'

/** 大 IN 列表分批上限(避免超长 SQL;候选集大时仍为精确扫描)。 */
const IN_BATCH = 500

export class MySQLBlobVectorStore implements VectorStore {
  /** 写入/更新 chunk 的 embedding(Float32 BLOB)。跨租户/不存在 → 抛错拒绝。 */
  async upsert(items: VectorUpsertItem[]): Promise<void> {
    for (const item of items) {
      const blob = encodeFloat32Vector(item.embedding)
      const affected = await execute(
        `UPDATE t_dsh_knowledge_chunks c
            SET c.embedding = ?
          WHERE c.id = ? AND c.doc_id = ? AND c.kb_id = ?
            AND c.kb_id IN (SELECT id FROM t_dsh_knowledge_bases WHERE tenant_id = ?)`,
        [blob, item.chunkId, item.docId, item.kbId, item.tenantId])
      if (affected === 0) throw new Error('chunk-not-found-or-forbidden')
    }
  }

  /** 文档删除/重建:清除该文档全部向量(保留 chunk;tenant 归属经 join 校验)。 */
  async deleteByDocument(tenantId: string, docId: string): Promise<void> {
    await execute(
      `UPDATE t_dsh_knowledge_chunks c
          LEFT JOIN t_dsh_knowledge_bases kb ON kb.id = c.kb_id
            SET c.embedding = NULL
          WHERE c.doc_id = ? AND kb.tenant_id = ?`,
      [docId, tenantId])
  }

  /** scope 限定的精确向量检索:候选 → 解码 → cosine → 排序 → topK。 */
  async search(
    queryEmbedding: number[],
    scope: VectorSearchScope,
    topK: number,
  ): Promise<VectorSearchResult[]> {
    const ids = scope.allowedChunkIds
    if (ids.length === 0) return []
    const candidates: Array<{ chunkId: string; blob: Buffer }> = []
    for (let i = 0; i < ids.length; i += IN_BATCH) {
      const batch = ids.slice(i, i + IN_BATCH)
      const placeholders = batch.map(() => '?').join(',')
      const rows = await queryMany<{ chunkId: string; vec: Buffer }>(
        `SELECT c.id AS chunkId, c.embedding AS vec
           FROM t_dsh_knowledge_chunks c
           JOIN t_dsh_knowledge_documents d ON d.id = c.doc_id AND d.status = 'ready'
          WHERE c.id IN (${placeholders})
            AND c.embedding IS NOT NULL`,
        batch)
      candidates.push(...rows.map((r) => ({ chunkId: r.chunkId, blob: r.vec })))
    }
    const scored: VectorSearchResult[] = []
    for (const row of candidates) {
      const vec = decodeFloat32Vector(row.blob)
      if (vec === null) continue // 损坏/空 BLOB:跳过,不产生错误 score
      try {
        scored.push({ chunkId: row.chunkId, score: cosineSimilarity(queryEmbedding, vec) })
      } catch {
        // 零向量/维度损坏:跳过该候选(不静默给分,也不中断整次检索)
      }
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, Math.max(1, topK))
  }
}

export const mysqlBlobVectorStore = new MySQLBlobVectorStore()
