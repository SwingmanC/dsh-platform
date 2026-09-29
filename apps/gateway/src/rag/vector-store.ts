/**
 * K-T6-lite:VectorStore 抽象边界(K-T4 决策的实现接口)。
 *
 * 安全边界(最高优先):
 * - VectorStore 不决定用户有权访问什么;
 * - scope(allowedChunkIds / allowedKbIds)必须由 Knowledge Service 在调用前
 *   经 ACL/mount/tenant 过滤计算完成,并以必传参数传入;
 * - 禁止"全库检索 → topK → 再 ACL 过滤"的调用形态。
 */

export interface VectorUpsertItem {
  chunkId: string
  docId: string
  kbId: string
  tenantId: string
  embedding: number[]
}

export interface VectorSearchScope {
  tenantId: string
  /** ACL 预过滤后的允许 chunk 集合(必传;由 Knowledge Service 计算)。 */
  allowedChunkIds: string[]
  /** 允许的 KB 集合(可选;与 allowedChunkIds 同时生效)。 */
  allowedKbIds?: string[]
}

export interface VectorSearchResult {
  chunkId: string
  score: number
}

export interface VectorStore {
  upsert(items: VectorUpsertItem[]): Promise<void>
  /** 文档删除/重建时清除其向量(当前 schema:embedding = NULL,保留 chunk 本身)。 */
  deleteByDocument(tenantId: string, docId: string): Promise<void>
  search(queryEmbedding: number[], scope: VectorSearchScope, topK: number): Promise<VectorSearchResult[]>
}

// --- Float32 稳定编码(K-T4 已验证:number[] → Float32Array → Buffer → BLOB) ---

/** 校验并编码:拒绝非有限值/空向量;dims > 0 时强制维度一致。 */
export function encodeFloat32Vector(embedding: number[], dims = 0): Buffer {
  if (!Array.isArray(embedding) || embedding.length === 0) throw new Error('invalid-vector:empty')
  for (const n of embedding) {
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error('invalid-vector:non-finite')
  }
  if (dims > 0 && embedding.length !== dims) throw new Error('dimension-mismatch')
  const f32 = new Float32Array(embedding)
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)
}

/** 解码 BLOB → number[];长度非 4 倍数视为损坏 → null(由调用方跳过)。
 *  注意:mysql2 返回的 Buffer 可能位于池内非 4 对齐偏移,必须先拷贝到对齐内存。 */
export function decodeFloat32Vector(buf: Buffer): number[] | null {
  if (buf.length === 0 || buf.length % 4 !== 0) return null
  const aligned = new ArrayBuffer(buf.length)
  new Uint8Array(aligned).set(buf)
  const f32 = new Float32Array(aligned)
  return Array.from(f32)
}

/**
 * 精确 cosine(K-T4 PoC 已验证语义):
 * 维度不一致 / 零向量 / NaN / Infinity → 抛错,不静默产生错误 score。
 */
export function cosineSimilarity(query: number[], vector: number[]): number {
  if (query.length !== vector.length) throw new Error('dimension-mismatch')
  let dot = 0
  let nq = 0
  let nv = 0
  for (let i = 0; i < query.length; i += 1) {
    const a = query[i]!
    const b = vector[i]!
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('invalid-vector:non-finite')
    dot += a * b
    nq += a * a
    nv += b * b
  }
  if (nq === 0 || nv === 0) throw new Error('zero-vector')
  return dot / (Math.sqrt(nq) * Math.sqrt(nv))
}
