/**
 * K-T6-lite:Hybrid Retrieval 纯函数(可单测)。
 *
 * RRF(Reciprocal Rank Fusion,k=60):
 *   score(chunk) = Σ_lists 1 / (k + rank_i),rank 从 1 起。
 * 融合后按 score 降序、同分按首次出现顺序稳定排序,取 topK。
 */

export const RRF_K = 60

export interface RankedChunk {
  chunkId: string
  content: unknown
  [key: string]: unknown
}

export interface FusedChunk<T extends RankedChunk = RankedChunk> {
  chunk: T
  score: number
  /** 命中的排名来源:'k' = keyword,'v' = vector。 */
  sources: string
}

/**
 * RRF 融合:输入两个已排序(最优在前)的 chunk 列表,输出融合 topK。
 * 同一 chunk 以先出现者为准(内容对象不重复合并)。
 */
export function rrfFuse<T extends RankedChunk>(
  keywordRanked: T[],
  vectorRanked: T[],
  opts: { k?: number; topK?: number } = {},
): FusedChunk<T>[] {
  const k = opts.k ?? 60
  const topK = opts.topK ?? 6
  const byId = new Map<string, FusedChunk<T>>()
  const order: string[] = []
  const add = (list: T[], tag: 'k' | 'v'): void => {
    for (let rank = 0; rank < list.length; rank += 1) {
      const chunk = list[rank]!
      const id = chunk.chunkId
      if (id === undefined || id === null) continue
      let entry = byId.get(id)
      if (entry === undefined) {
        entry = { chunk, score: 0, sources: '' }
        byId.set(id, entry)
        order.push(id)
      }
      entry.score += 1 / (k + rank + 1)
      entry.sources += tag
    }
  }
  add(keywordRanked, 'k')
  add(vectorRanked, 'v')
  return order
    .map((id) => byId.get(id)!)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}
