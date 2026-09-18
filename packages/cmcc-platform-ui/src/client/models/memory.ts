/**
 * Memory 面板 model:记忆列表/搜索/创建/删除/提升 + Runtime 投影状态。
 */
import type { MemoryRecord, MemorySearchResult, MemoryVisibility } from './types.js'
import type { ResourceState } from './resource.js'
import { runLoad } from './resource.js'
import type { MemoryRuntimeStatus } from '../platform-api.js'

export interface MemoryApi {
  listMemory(query: { q?: string; namespace?: string; kind?: string; visibility?: string; limit?: number }): Promise<MemorySearchResult>
  listMemoryNamespaces(): Promise<{ namespaces: string[] }>
  createMemory(input: { content: string; namespace?: string; kind?: string }): Promise<MemoryRecord>
  deleteMemory(id: string): Promise<{ ok: true }>
  promoteMemory(id: string, targetVisibility: MemoryVisibility): Promise<{ ok: true }>
  getMemoryRuntimeStatus?(): Promise<MemoryRuntimeStatus>
}

export interface MemoryPanelData {
  records: MemoryRecord[]
  total: number
  namespaces: string[]
  runtime: MemoryRuntimeStatus | null
}

export function loadMemory(
  api: MemoryApi,
  query: { q?: string; namespace?: string; kind?: string; visibility?: string } = {},
): Promise<ResourceState<MemoryPanelData>> {
  return runLoad(async () => {
    const runtimePromise = typeof api.getMemoryRuntimeStatus === 'function'
      ? api.getMemoryRuntimeStatus().catch(() => null)
      : Promise.resolve(null)
    const [result, ns, runtime] = await Promise.all([
      api.listMemory({ ...query, limit: 50 }),
      api.listMemoryNamespaces(),
      runtimePromise,
    ])
    return { records: result.records, total: result.total, namespaces: ns.namespaces, runtime }
  }, (data) => data.records.length === 0)
}

export async function createMemoryAndReload(
  api: MemoryApi,
  input: { content: string; namespace?: string; kind?: string },
  query: { q?: string; namespace?: string; kind?: string; visibility?: string } = {},
): Promise<ResourceState<MemoryPanelData>> {
  await api.createMemory(input)
  return loadMemory(api, query)
}

export async function deleteMemoryAndReload(api: MemoryApi, id: string, query: { q?: string; namespace?: string; kind?: string; visibility?: string } = {}): Promise<ResourceState<MemoryPanelData>> {
  await api.deleteMemory(id)
  return loadMemory(api, query)
}

export async function promoteMemoryAndReload(
  api: MemoryApi,
  id: string,
  targetVisibility: MemoryVisibility,
  query: { q?: string; namespace?: string; kind?: string; visibility?: string } = {},
): Promise<ResourceState<MemoryPanelData>> {
  await api.promoteMemory(id, targetVisibility)
  return loadMemory(api, query)
}

export function memoryVisibilityLabel(visibility: string): string {
  return visibility === 'tenant_shared' ? '租户共享' : '个人'
}

export function memoryKindLabel(kind: string): string {
  const map: Record<string, string> = {
    preference: '偏好', fact: '事实', decision: '决策', instruction: '指令', other: '其他',
  }
  return map[kind] ?? kind
}

export function memoryExtractionLabel(mode: string): string {
  const map: Record<string, string> = { manual: '手工创建', explicit_user: '自动提取(显式)', llm: 'LLM 提取' }
  return map[mode] ?? mode
}

export function memoryRuntimeStateLabel(state: string): string {
  const map: Record<string, string> = {
    CONNECTED: '已同步', SYNCING: '同步中', ERROR: '错误',
    RUNTIME_STOPPED: 'Runtime 未运行', NO_MEMORY: '暂无记忆', NOT_CONNECTED: '未接入',
  }
  return map[state] ?? state
}