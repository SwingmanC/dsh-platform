/**
 * K-T7:Citation 稳定 ID(纯函数)。
 *
 * 格式:kb:<kbId>:doc:<docId>:ver:<versionId>:chunk:<chunkId>
 * 稳定性:同 document version + chunk 连续生成结果一致(无随机成分)。
 * 注意:citationId 不是读取凭据 —— 任何 resolve 必须重新执行 Knowledge ACL。
 */

export interface CitationParts {
  kbId: string
  docId: string
  versionId: string
  chunkId: string
}

export function buildCitationId(parts: CitationParts): string {
  return `kb:${parts.kbId}:doc:${parts.docId}:ver:${parts.versionId}:chunk:${parts.chunkId}`
}

/** 解析 citationId;格式不符 → null(malformed,由调用方返回 400)。 */
export function parseCitationId(citationId: string): CitationParts | null {
  const parts = citationId.split(':')
  if (parts.length !== 8) return null
  if (parts[0] !== 'kb' || parts[2] !== 'doc' || parts[4] !== 'ver' || parts[6] !== 'chunk') return null
  const kbId = parts[1]!
  const docId = parts[3]!
  const versionId = parts[5]!
  const chunkId = parts[7]!
  if (kbId === '' || docId === '' || versionId === '' || chunkId === '') return null
  return { kbId, docId, versionId, chunkId }
}
