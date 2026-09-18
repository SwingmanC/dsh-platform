/**
 * Memory 投影读取 + 缓存。
 *
 * recall context provider 必须同步返回,因此投影在内存中缓存,由 fs.watch 刷新。
 */
import { watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

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

export async function readProjection(dir: string): Promise<MemoryProjection | null> {
  try {
    const raw = await readFile(path.join(dir, 'catalog.json'), 'utf8')
    const data = JSON.parse(raw) as MemoryProjection
    if (typeof data.revision !== 'string' || !Array.isArray(data.memories)) return null
    return data
  } catch {
    return null
  }
}

export interface ProjectionCache {
  get: () => MemoryProjection | null
  close: () => void
}

/** 缓存投影;catalog.json 变化后 debounce 刷新。 */
export function createProjectionCache(dir: string, debounceMs = 200): ProjectionCache {
  let current: MemoryProjection | null = null
  let timer: NodeJS.Timeout | null = null
  let closed = false
  let watcher: ReturnType<typeof watch> | null = null

  const refresh = async (): Promise<void> => {
    const next = await readProjection(dir)
    if (!closed) current = next
  }

  void refresh()

  try {
    watcher = watch(dir, { persistent: false }, (_event, filename) => {
      if (filename !== null && filename !== 'catalog.json') return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; void refresh() }, debounceMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    watcher.on('error', () => { /* ignore */ })
  } catch {
    watcher = null
  }

  return {
    get: () => current,
    close: () => {
      if (closed) return
      closed = true
      if (timer !== null) { clearTimeout(timer); timer = null }
      watcher?.close()
      watcher = null
    },
  }
}