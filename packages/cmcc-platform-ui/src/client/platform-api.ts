/**
 * PlatformApiClient —— 集中封装平台 Gateway REST API。
 *
 * 纪律:
 * - React 组件不直接 `fetch('/api/...')`;一律经本 client。
 * - 身份由 Gateway 从当前 authenticated principal 推导;**绝不**由前端传
 *   userId / tenantId / ownerId(本 client 的输入只有 resource id 与 mutation payload)。
 * - 写操作带 CSRF 双提交 header;GET 不带。
 * - 错误归一为 PlatformApiError(用户可读),不暴露 stack/SQL/token。
 *
 * 说明:本阶段集中封装现有 `/api/*` endpoint(route namespace 迁移 `/platform-api/*`
 * 记为 follow-up,避免扩大范围)。
 */
import type {
  KnowledgeBase,
  KbChunk,
  KbDocument,
  KbSearchResult,
  MCPConnector,
  MemoryRecord,
  MemorySearchResult,
  MemoryVisibility,
  Skill,
  SkillListResult,
} from './models/types.js'

/** Knowledge Runtime 投影状态(来自 Gateway 真实 evidence)。 */
export interface KnowledgeRuntimeStatus {
  provider: string
  state: 'CONNECTED' | 'SYNCING' | 'ERROR' | 'RUNTIME_STOPPED' | 'NO_MOUNTED_KB' | 'NOT_CONNECTED'
  desiredRevision: string | null
  observedRevision: string | null
  lastObservedAt: string | null
  error: string | null
  chunkCount: number
  mountedKbCount: number
  generatedAt: string | null
}
export interface SkillRuntimeStatus {
  provider: string
  state: 'CONNECTED' | 'SYNCING' | 'ERROR' | 'RUNTIME_STOPPED' | 'NOT_CONNECTED'
  desiredRevision: string | null
  observedRevision: string | null
  lastObservedAt: string | null
  error: string | null
  skillCount: number
  generatedAt: string | null
}

/** MCP Runtime 投影状态(来自 Gateway 真实 evidence)。 */
export interface McpRuntimeStatus {
  provider: string
  state: 'RUNTIME_STOPPED' | 'SYNCING' | 'RESTART_REQUIRED' | 'CONNECTING' | 'CONNECTED' | 'DEGRADED' | 'ERROR' | 'NOT_CONNECTED'
  desiredRevision: string | null
  observedRevision: string | null
  lastObservedAt: string | null
  error: string | null
  serverCount: number
  generatedAt: string | null
  desiredServers: string[]
  observedServers: string[]
  observedToolCount: number
  excluded: Array<{ connectorId: string; reason: string }>
  applyMode: string
}

/** Memory Runtime 投影状态(来自 Gateway 真实 evidence)。 */
export interface MemoryRuntimeStatus {
  provider: string
  state: 'RUNTIME_STOPPED' | 'SYNCING' | 'CONNECTED' | 'ERROR' | 'NO_MEMORY' | 'NOT_CONNECTED'
  desiredRevision: string | null
  observedRevision: string | null
  lastObservedAt: string | null
  error: string | null
  memoryCount: number
  generatedAt: string | null
  recallCount: number
  lastRecallAt: string | null
  teamRuntime: boolean
}

export interface UsageCounts {
  attempts: number; nonSurfaceAttempts: number; unknownUsageAttempts: number
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number
  cacheReadKnownAttempts: number; cacheWriteKnownAttempts: number; reasoningKnownAttempts: number
}

export interface UsageSummary {
  totals: UsageCounts & { turns: number }
  daily: Array<UsageCounts & { day: string; turns: number }>
  users: Array<UsageCounts & { userId: string; displayName: string; turns: number }>
  models: Array<UsageCounts & { provider: string; model: string }>
}

/** 归一化 API 错误。 */
export class PlatformApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(status === 0 ? 'network-error' : `http-${status}:${code}`)
    this.name = 'PlatformApiError'
  }
}

/** 读取非 HttpOnly 的 CSRF 双提交 cookie。 */
function csrfToken(): string {
  if (typeof document === 'undefined') return ''
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/)
  return match?.[1] === undefined ? '' : decodeURIComponent(match[1])
}

async function parseErrorCode(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string; code?: string }
    return data.code ?? data.error ?? `http-${res.status}`
  } catch {
    return `http-${res.status}`
  }
}

export interface SkillListQuery {
  q?: string
  visibility?: string
  category?: string
  status?: string
  limit?: number
  offset?: number
}

export interface CreateSkillInput {
  name: string
  description?: string
  prompt?: string
  visibility?: string
  category?: string
}

export interface CreateKnowledgeBaseInput {
  name: string
  description?: string
  visibility?: string
  category?: string
}

export interface CreateConnectorInput {
  name: string
  serverName: string
  transport: string
  command?: string
  endpointUrl?: string
  authType?: string
  scope?: string
  riskLevel?: string
  visibility?: string
}

export interface MemoryListQuery {
  q?: string
  namespace?: string
  visibility?: string
  limit?: number
  offset?: number
}

export interface CreateMemoryInput {
  content: string
  namespace?: string
  kind?: string
}

function qs(params: Record<string, string | number | undefined>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

export class PlatformApiClient {
  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  private async request<T>(url: string, init?: RequestInit): Promise<T> {
    let res: Response
    try {
      res = await this.fetchImpl(url, {
        credentials: 'include',
        ...init,
        headers: { accept: 'application/json', ...(init?.headers as Record<string, string> | undefined) },
      })
    } catch {
      throw new PlatformApiError(0, 'network-error')
    }
    if (!res.ok) throw new PlatformApiError(res.status, await parseErrorCode(res))
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  private mutate<T>(url: string, method: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'x-csrf-token': csrfToken() }
    if (body !== undefined) headers['content-type'] = 'application/json'
    return this.request<T>(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  }

  getCurrentUser(): Promise<{ role: 'tenant_admin' | 'operator' | 'member' }> {
    return this.request('/auth/me')
  }

  getUsageSummary(days: 7 | 30 | 90 = 30): Promise<UsageSummary> {
    return this.request<UsageSummary>(`/api/usage/summary?days=${days}`)
  }

  // --- Skills ---
  listSkills(query: SkillListQuery = {}): Promise<SkillListResult> {
    return this.request<SkillListResult>(`/api/skills${qs({ ...query })}`)
  }

  listInstalledSkills(): Promise<{ skills: Skill[] }> {
    return this.request<{ skills: Skill[] }>('/api/skills/installed')
  }

  /** Skill Runtime 投影状态(真实 evidence:desired/observed revision + Runtime 进程状态)。 */
  getSkillRuntimeStatus(): Promise<SkillRuntimeStatus> {
    return this.request<SkillRuntimeStatus>('/api/skills/runtime-status')
  }

  getSkill(id: string): Promise<Skill> {
    return this.request<Skill>(`/api/skills/${encodeURIComponent(id)}`)
  }

  createSkill(input: CreateSkillInput): Promise<Skill> {
    return this.mutate<Skill>('/api/skills', 'POST', input)
  }

  publishSkill(id: string): Promise<{ ok: true }> {
    return this.mutate<{ ok: true }>(`/api/skills/${encodeURIComponent(id)}/publish`, 'POST')
  }

  installSkill(id: string): Promise<{ ok: true }> {
    return this.mutate<{ ok: true }>(`/api/skills/${encodeURIComponent(id)}/install`, 'POST')
  }

  uninstallSkill(id: string): Promise<{ ok: true }> {
    return this.mutate<{ ok: true }>(`/api/skills/${encodeURIComponent(id)}/install`, 'DELETE')
  }

  // --- Knowledge ---
  listKnowledgeBases(): Promise<{ knowledgeBases: KnowledgeBase[] }> {
    return this.request<{ knowledgeBases: KnowledgeBase[] }>('/api/knowledge-bases')
  }

  createKnowledgeBase(input: CreateKnowledgeBaseInput): Promise<KnowledgeBase> {
    return this.mutate<KnowledgeBase>('/api/knowledge-bases', 'POST', input)
  }

  listKbDocuments(kbId: string): Promise<{ documents: KbDocument[] }> {
    return this.request<{ documents: KbDocument[] }>(`/api/knowledge-bases/${encodeURIComponent(kbId)}/documents`)
  }

  searchKnowledge(query: { q: string; kbId?: string; limit?: number }): Promise<KbSearchResult> {
    return this.request<KbSearchResult>(`/api/knowledge/search${qs({ ...query })}`)
  }

  mountKnowledgeBase(kbId: string): Promise<{ ok: true }> {
    return this.mutate<{ ok: true }>(`/api/knowledge-bases/${encodeURIComponent(kbId)}/mount`, 'POST')
  }

  unmountKnowledgeBase(kbId: string): Promise<{ ok: true }> {
    return this.mutate<{ ok: true }>(`/api/knowledge-bases/${encodeURIComponent(kbId)}/mount`, 'DELETE')
  }

  listMounts(): Promise<{ mounts: KnowledgeBase[] }> {
    return this.request<{ mounts: KnowledgeBase[] }>('/api/knowledge/mounts')
  }

  /** Knowledge Runtime 投影状态(真实 evidence)。 */
  getKnowledgeRuntimeStatus(): Promise<KnowledgeRuntimeStatus> {
    return this.request<KnowledgeRuntimeStatus>('/api/knowledge/runtime-status')
  }

  /** 上传文档到 KB(按文本内容上传)。 */
  uploadDocument(kbId: string, filename: string, content: string): Promise<KbDocument> {
    return this.mutate<KbDocument>(`/api/knowledge-bases/${encodeURIComponent(kbId)}/documents`, 'POST', { filename, content })
  }

  // --- MCP ---
  listConnectors(): Promise<{ connectors: MCPConnector[] }> {
    return this.request<{ connectors: MCPConnector[] }>('/api/connectors')
  }

  createConnector(input: CreateConnectorInput): Promise<MCPConnector> {
    return this.mutate<MCPConnector>('/api/connectors', 'POST', input)
  }

  approveConnector(id: string): Promise<{ ok: true }> {
    return this.mutate<{ ok: true }>(`/api/connectors/${encodeURIComponent(id)}/approve`, 'POST')
  }

  authorizeConnector(id: string): Promise<{ ok: true }> {
    return this.mutate<{ ok: true }>(`/api/connectors/${encodeURIComponent(id)}/authorize`, 'POST')
  }

  revokeConnector(id: string): Promise<{ ok: true }> {
    return this.mutate<{ ok: true }>(`/api/connectors/${encodeURIComponent(id)}/authorize`, 'DELETE')
  }

  disableConnector(id: string): Promise<{ ok: true }> {
    return this.mutate<{ ok: true }>(`/api/connectors/${encodeURIComponent(id)}/disable`, 'POST')
  }

  /** 保存/轮换 credential(仅提交,响应不含 secret)。 */
  saveConnectorCredential(id: string, secret: string): Promise<{ ok: true; configured: true }> {
    return this.mutate<{ ok: true; configured: true }>(`/api/connectors/${encodeURIComponent(id)}/credential`, 'PUT', { secret })
  }

  /** MCP Runtime 投影状态(真实 evidence)。 */
  getMcpRuntimeStatus(): Promise<McpRuntimeStatus> {
    return this.request<McpRuntimeStatus>('/api/connectors/runtime-status')
  }

  listAuthorizedConnectors(): Promise<{ connectors: MCPConnector[] }> {
    return this.request<{ connectors: MCPConnector[] }>('/api/connectors/authorized')
  }

  // --- Memory ---
  listMemory(query: MemoryListQuery = {}): Promise<MemorySearchResult> {
    return this.request<MemorySearchResult>(`/api/memory${qs({ ...query })}`)
  }

  listMemoryNamespaces(): Promise<{ namespaces: string[] }> {
    return this.request<{ namespaces: string[] }>('/api/memory/namespaces')
  }

  /** Memory Runtime 投影状态(真实 evidence)。 */
  getMemoryRuntimeStatus(): Promise<MemoryRuntimeStatus> {
    return this.request<MemoryRuntimeStatus>('/api/memory/runtime-status')
  }

  createMemory(input: CreateMemoryInput): Promise<MemoryRecord> {
    return this.mutate<MemoryRecord>('/api/memory', 'POST', input)
  }

  deleteMemory(id: string): Promise<{ ok: true }> {
    return this.mutate<{ ok: true }>(`/api/memory/${encodeURIComponent(id)}`, 'DELETE')
  }

  promoteMemory(id: string, targetVisibility: MemoryVisibility): Promise<{ ok: true }> {
    return this.mutate<{ ok: true }>(`/api/memory/${encodeURIComponent(id)}/promote`, 'POST', { targetVisibility })
  }
}

/** 单例(浏览器侧);测试可注入 mock fetch 构造新实例。 */
export const platformApi = new PlatformApiClient()

/** 供测试使用:平台数据中可直接引用的 chunk 类型(避免未使用告警)。 */
export type { KbChunk }
