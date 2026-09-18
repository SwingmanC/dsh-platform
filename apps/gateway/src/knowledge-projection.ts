import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'

const UUID_RE = /^[0-9a-fA-F-]{36}$/
const PROJECTION_SCHEMA_VERSION = 1

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
  /** 该用户可检索的 chunk refs(只含 ACL 预过滤后的授权集合)。 */
  chunks: ProjectionChunkRef[]
  /** mounted KB ids(用于 Runtime 快速校验)。 */
  mountedKbIds: string[]
}

function safeSegment(value: string): string {
  if (!UUID_RE.test(value)) throw new Error(`unsafe projection path: ${value}`)
  return value
}

export function knowledgeProjectionDir(tenantId: string, userId: string): string {
  return path.join(config.knowledge.projectionsRoot, safeSegment(tenantId), safeSegment(userId), 'knowledge')
}

function revisionOf(data: { chunks: ProjectionChunkRef[]; mountedKbIds: string[] }): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16)
}

export interface KnowledgeProjectionBuilder {
  build(userId: string, tenantId: string): Promise<void>
}

export async function writeKnowledgeProjection(
  tenantId: string, userId: string,
  data: { chunks: ProjectionChunkRef[]; mountedKbIds: string[] },
): Promise<string> {
  const dir = knowledgeProjectionDir(tenantId, userId)
  await mkdir(dir, { recursive: true })
  const revision = revisionOf(data)
  const projection: KnowledgeProjectionData = {
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    revision, generatedAt: new Date().toISOString(),
    tenantId, userId, chunks: data.chunks, mountedKbIds: data.mountedKbIds,
  }
  const file = path.join(dir, 'projection.json')
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(projection), 'utf8')
  await rename(tmp, file)
  await writeFile(path.join(dir, 'status.json'), JSON.stringify({
    desiredRevision: revision, generatedAt: projection.generatedAt, chunkCount: data.chunks.length,
    mountedKbCount: data.mountedKbIds.length,
  }, null, 2), 'utf8')
  return revision
}

export interface KnowledgeProjectionStatus {
  state: 'CONNECTED' | 'SYNCING' | 'ERROR' | 'RUNTIME_STOPPED' | 'NO_MOUNTED_KB' | 'NOT_CONNECTED'
  desiredRevision: string | null
  observedRevision: string | null
  lastObservedAt: string | null
  error: string | null
  chunkCount: number
  mountedKbCount: number
  generatedAt: string | null
}

export async function readKnowledgeProjectionStatus(
  tenantId: string, userId: string, runtimeState: string | undefined,
): Promise<KnowledgeProjectionStatus> {
  const dir = knowledgeProjectionDir(tenantId, userId)
  const status = await readJson<{ desiredRevision: string; generatedAt: string; chunkCount: number; mountedKbCount: number }>(path.join(dir, 'status.json'))
  const ack = await readJson<{ observedRevision: string; lastObservedAt: string; error?: string }>(path.join(dir, 'ack.json'))
  const desiredRevision = status?.desiredRevision ?? null
  const observedRevision = ack?.observedRevision ?? null
  let state: KnowledgeProjectionStatus['state']
  if (runtimeState !== 'ready') state = 'RUNTIME_STOPPED'
  else if (typeof ack?.error === 'string' && ack.error !== '') state = 'ERROR'
  else if (desiredRevision === null) state = 'NOT_CONNECTED'
  else if ((status?.mountedKbCount ?? 0) === 0) state = 'NO_MOUNTED_KB'
  else if (observedRevision === desiredRevision) state = 'CONNECTED'
  else state = 'SYNCING'
  return {
    state, desiredRevision, observedRevision,
    lastObservedAt: ack?.lastObservedAt ?? null, error: ack?.error ?? null,
    chunkCount: status?.chunkCount ?? 0, mountedKbCount: status?.mountedKbCount ?? 0,
    generatedAt: status?.generatedAt ?? null,
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T } catch { return null }
}