/**
 * Knowledge 面板 model:知识库列表/创建/上传/挂载/检索/Runtime 投影状态。
 */
import type { KbDocument, KbSearchResult, KnowledgeBase } from './types.js'
import type { ResourceState } from './resource.js'
import { runLoad } from './resource.js'
import type { KnowledgeRuntimeStatus } from '../platform-api.js'

export interface KnowledgeApi {
  listKnowledgeBases(): Promise<{ knowledgeBases: KnowledgeBase[] }>
  listMounts(): Promise<{ mounts: KnowledgeBase[] }>
  createKnowledgeBase(input: { name: string; description?: string; visibility?: string }): Promise<KnowledgeBase>
  mountKnowledgeBase(id: string): Promise<{ ok: true }>
  unmountKnowledgeBase(id: string): Promise<{ ok: true }>
  listKbDocuments(kbId: string): Promise<{ documents: KbDocument[] }>
  searchKnowledge(query: { q: string; kbId?: string; limit?: number }): Promise<KbSearchResult>
  uploadDocument(kbId: string, filename: string, content: string): Promise<KbDocument>
  getKnowledgeRuntimeStatus?(): Promise<KnowledgeRuntimeStatus>
}

export interface KnowledgePanelData {
  bases: KnowledgeBase[]
  mountedIds: string[]
  runtime: KnowledgeRuntimeStatus | null
}

export function loadKnowledge(api: KnowledgeApi): Promise<ResourceState<KnowledgePanelData>> {
  return runLoad(async () => {
    const runtimePromise = typeof api.getKnowledgeRuntimeStatus === 'function'
      ? api.getKnowledgeRuntimeStatus().catch(() => null)
      : Promise.resolve(null)
    const [bases, mounts, runtime] = await Promise.all([api.listKnowledgeBases(), api.listMounts(), runtimePromise])
    return { bases: bases.knowledgeBases, mountedIds: mounts.mounts.map((m) => m.id), runtime }
  }, (data) => data.bases.length === 0)
}

export async function createKnowledgeBaseAndReload(
  api: KnowledgeApi,
  input: { name: string; description?: string; visibility?: string },
): Promise<ResourceState<KnowledgePanelData>> {
  await api.createKnowledgeBase(input)
  return loadKnowledge(api)
}

export async function mountKnowledgeBaseAndReload(api: KnowledgeApi, id: string): Promise<ResourceState<KnowledgePanelData>> {
  await api.mountKnowledgeBase(id)
  return loadKnowledge(api)
}

export async function unmountKnowledgeBaseAndReload(api: KnowledgeApi, id: string): Promise<ResourceState<KnowledgePanelData>> {
  await api.unmountKnowledgeBase(id)
  return loadKnowledge(api)
}

export function loadDocuments(api: KnowledgeApi, kbId: string): Promise<ResourceState<KbDocument[]>> {
  return runLoad(() => api.listKbDocuments(kbId).then((r) => r.documents), (docs) => docs.length === 0)
}

export function searchChunks(api: KnowledgeApi, query: { q: string; kbId?: string }): Promise<ResourceState<KbSearchResult>> {
  return runLoad(() => api.searchKnowledge({ ...query, limit: 20 }), (r) => r.chunks.length === 0)
}

export function kbVisibilityLabel(visibility: string): string {
  return visibility === 'tenant' ? '租户' : '个人'
}

export function docStatusLabel(status: string): string {
  const map: Record<string, string> = {
    uploaded: '已上传', parsing: '解析中', chunking: '分块中',
    ready: '就绪', failed: '失败', archived: '已归档',
  }
  return map[status] ?? status
}

export function knowledgeRuntimeStateLabel(state: string): string {
  const map: Record<string, string> = {
    CONNECTED: '已同步', SYNCING: '同步中', ERROR: '错误',
    RUNTIME_STOPPED: 'Runtime 未运行', NO_MOUNTED_KB: '未挂载 KB', NOT_CONNECTED: '未接入',
  }
  return map[state] ?? state
}