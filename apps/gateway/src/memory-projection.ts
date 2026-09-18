/**
 * Memory Runtime 投影(Gateway-owned derived projection)。
 *
 * 架构:
 *   Platform DB(authoritative)
 *     → Gateway 按 principal + scope prefilter 生成每用户投影
 *     → cmcc-memory-runtime 只读消费(recall/search)
 *     → 写操作经 Gateway internal mutation channel
 *
 * 安全:
 * - 路径由服务端 principal 生成(UUID)。
 * - 默认只投影 personal/private(TEAM_MEMORY_RUNTIME = DISABLED)。
 * - 不含 secret。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import { memoryRepository } from './repositories/memory-repository.js'

const UUID_RE = /^[0-9a-fA-F-]{36}$/
export const MEMORY_PROJECTION_SCHEMA_VERSION = 1

export interface ProjectedMemory {
  id: string
  kind: string
  content: string
  scope: string
  namespace: string
  revision: number
  sourceType: string
  extractionMode: string
  sourceSessionId: string | null
  updatedAt: string
}

export interface MemoryProjection {
  schemaVersion: number
  revision: string
  generatedAt: string
  tenantId: string
  userId: string
  memories: ProjectedMemory[]
}

export interface MemoryProjectionBuildResult {
  revision: string
  memoryCount: number
}

function safeSegment(value: string): string {
  if (!UUID_RE.test(value)) throw new Error(`unsafe memory projection path: ${value}`)
  return value
}

export function memoryProjectionDir(tenantId: string, userId: string): string {
  return path.join(config.memory.projectionsRoot, safeSegment(tenantId), safeSegment(userId), 'memory')
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, file)
}

function revisionOf(memories: ProjectedMemory[]): string {
  return createHash('sha256').update(JSON.stringify(memories)).digest('hex').slice(0, 16)
}

/**
 * 构建某用户 Memory 投影。默认只含 personal/private(team disabled)。
 */
export async function buildMemoryProjection(tenantId: string, userId: string): Promise<MemoryProjectionBuildResult> {
  const dir = memoryProjectionDir(tenantId, userId)
  const rows = await memoryRepository.listProjectable(userId, tenantId)
  const memories: ProjectedMemory[] = rows.map((r) => ({
    id: r.id, kind: r.kind, content: r.content, scope: r.visibility, namespace: r.namespace,
    revision: r.revision, sourceType: r.sourceType, extractionMode: r.extractionMode,
    sourceSessionId: r.sourceSessionId, updatedAt: r.updatedAt,
  }))
  const revision = revisionOf(memories)
  const projection: MemoryProjection = {
    schemaVersion: MEMORY_PROJECTION_SCHEMA_VERSION, revision, generatedAt: new Date().toISOString(),
    tenantId, userId, memories,
  }
  await mkdir(dir, { recursive: true })
  await atomicWrite(path.join(dir, 'catalog.json'), JSON.stringify(projection, null, 2))
  await atomicWrite(path.join(dir, 'status.json'), JSON.stringify({
    desiredRevision: revision, generatedAt: projection.generatedAt, memoryCount: memories.length,
  }, null, 2))
  return { revision, memoryCount: memories.length }
}

export async function readMemoryProjection(tenantId: string, userId: string): Promise<MemoryProjection | null> {
  try {
    return JSON.parse(await readFile(path.join(memoryProjectionDir(tenantId, userId), 'catalog.json'), 'utf8')) as MemoryProjection
  } catch {
    return null
  }
}

export interface MemoryProjectionStatus {
  state: 'RUNTIME_STOPPED' | 'SYNCING' | 'CONNECTED' | 'ERROR' | 'NO_MEMORY' | 'NOT_CONNECTED'
  desiredRevision: string | null
  observedRevision: string | null
  lastObservedAt: string | null
  error: string | null
  memoryCount: number
  generatedAt: string | null
  recallCount: number
  lastRecallAt: string | null
}

interface MemoryAck {
  observedRevision: string
  lastObservedAt: string
  error: string | null
  recallCount?: number
  lastRecallAt?: string
}

export async function readMemoryAck(tenantId: string, userId: string): Promise<MemoryAck | null> {
  try {
    return JSON.parse(await readFile(path.join(memoryProjectionDir(tenantId, userId), 'ack.json'), 'utf8')) as MemoryAck
  } catch {
    return null
  }
}

export async function readMemoryProjectionStatus(
  tenantId: string, userId: string, runtimeState: string | undefined,
): Promise<MemoryProjectionStatus> {
  const dir = memoryProjectionDir(tenantId, userId)
  const status = await readJson<{ desiredRevision: string; generatedAt: string; memoryCount: number }>(path.join(dir, 'status.json'))
  const ack = await readMemoryAck(tenantId, userId)
  const desiredRevision = status?.desiredRevision ?? null
  const observedRevision = ack?.observedRevision ?? null
  let state: MemoryProjectionStatus['state']
  if (runtimeState !== 'ready') state = 'RUNTIME_STOPPED'
  else if (typeof ack?.error === 'string' && ack.error !== '') state = 'ERROR'
  else if (desiredRevision === null) state = 'NOT_CONNECTED'
  else if ((status?.memoryCount ?? 0) === 0) state = 'NO_MEMORY'
  else if (observedRevision === desiredRevision) state = 'CONNECTED'
  else state = 'SYNCING'
  return {
    state, desiredRevision, observedRevision,
    lastObservedAt: ack?.lastObservedAt ?? null, error: ack?.error ?? null,
    memoryCount: status?.memoryCount ?? 0, generatedAt: status?.generatedAt ?? null,
    recallCount: ack?.recallCount ?? 0, lastRecallAt: ack?.lastRecallAt ?? null,
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T } catch { return null }
}