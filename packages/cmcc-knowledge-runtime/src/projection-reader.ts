/**
 * Knowledge projection 读取器。
 * 从 Gateway 投影目录读取每用户 ACL 预过滤的投影数据。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export interface ProjectionChunkRef {
  chunkId: string
  docId: string
  kbId: string
  kbName: string
  documentTitle: string
  ordinal: number
  snippet: string
  score: number
}

export interface KnowledgeProjectionData {
  schemaVersion: number
  revision: string
  generatedAt: string
  tenantId: string
  userId: string
  chunks: ProjectionChunkRef[]
  mountedKbIds: string[]
}

export async function readProjection(dir: string): Promise<KnowledgeProjectionData | null> {
  try {
    const raw = await readFile(path.join(dir, 'projection.json'), 'utf8')
    const data = JSON.parse(raw) as KnowledgeProjectionData
    if (typeof data.revision !== 'string' || !Array.isArray(data.chunks)) return null
    return data
  } catch {
    return null
  }
}