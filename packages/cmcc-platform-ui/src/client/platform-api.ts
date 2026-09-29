import type { AuditListQuery, AuditListResponse, AuditLogItem } from '@dsh-platform/shared'
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
  SkillImportPreflight,
  SkillListResult,
} from './models/types.js'
import type { CreateUserInput, UpdateUserInput, UserListQuery, UserListResponse, UserMutationResponse, DeleteUserResponse, MeResponse } from '@dsh-platform/shared'

/** K-T3:Embedding Provider 配置视图(永不包含明文 key/envelope)。 */
export interface EmbeddingConfigView {
  provider: string
  baseUrl: string
  model: string
  dims: number
  hasKey: boolean
  keyHint: string | null
  lastTestAt: string | null
  lastError: string | null
}

export interface EmbeddingConfigSaveInput {
  provider: string
  baseUrl: string
  model: string
  dims: number
  apiKey: string
}

export interface EmbeddingTestResult {
  ok: boolean
  provider?: string
  model?: string
  dims?: number
  latencyMs?: number
  code?: string
}

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

/** MCP 连接测试结果(Gateway 侧一次性探针;错误消息已在服务端脱敏)。 */
export interface McpTestResult {
  ok: boolean
  code?: string
  message?: string
  serverInfo?: Record<string, unknown> | null
  toolCount?: number
  tools?: Array<{
    name: string
    description: string | null
    /** MCP-V1.1:JSON Schema 原样透传(只读展示)。 */
    inputSchema?: Record<string, unknown>
  }>
  durationMs: number
  authConfigured: boolean
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

  getCurrentUser(): Promise<MeResponse> {
    return this.request('/auth/me')
  }

  getUsageSummary(days: 7 | 30 | 90 = 30): Promise<UsageSummary> {
    return this.request<UsageSummary>(`/api/usage/summary?days=${days}`)
  }

  listUsers(query: UserListQuery = {}): Promise<UserListResponse> {
    return this.request(`/api/admin/users${qs({ ...query })}`)
  }

  createUser(input: CreateUserInput): Promise<UserMutationResponse> {
    return this.mutate('/api/admin/users', 'POST', input)
  }

  updateUser(id: string, input: UpdateUserInput): Promise<UserMutationResponse> {
    return this.mutate(`/api/admin/users/${encodeURIComponent(id)}`, 'PATCH', input)
  }

  resetUserPassword(id: string, password: string): Promise<UserMutationResponse> {
    return this.mutate(`/api/admin/users/${encodeURIComponent(id)}/reset-password`, 'POST', { password })
  }

  deleteUser(id: string): Promise<DeleteUserResponse> {
    return this.mutate(`/api/admin/users/${encodeURIComponent(id)}`, 'DELETE')
  }

  listAuditEvents(query: AuditListQuery = {}): Promise<AuditListResponse> {
    return this.request(`/api/audit/events${qs({ ...query })}`)
  }

  getAuditEvent(id: string): Promise<AuditLogItem> {
    return this.request(`/api/audit/events/${encodeURIComponent(id)}`)
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

  /** SKILL-V1.1:作者编辑(owner-only;prompt 变更 → 新版本)。 */
  updateSkill(id: string, input: { description?: string; prompt?: string; whenToUse?: string; modelInvocable?: boolean; userInvocable?: boolean }): Promise<{ ok: true; version?: string }> {
    return this.mutate<{ ok: true; version?: string }>(`/api/skills/${encodeURIComponent(id)}`, 'PUT', input)
  }

  /** SKILL-V1.1:版本历史(owner-only)。 */
  getSkillVersions(id: string): Promise<{ versions: Array<{ version: string; createdAt: string }> }> {
    return this.request<{ versions: Array<{ version: string; createdAt: string }> }>(`/api/skills/${encodeURIComponent(id)}/versions`)
  }

  /** SKILL-V1.3:SKILL.md Import preflight(multipart;无 DB 写入)。 */
  importSkillPreflight(file: File): Promise<SkillImportPreflight> {
    return this.uploadFile<SkillImportPreflight>('/api/skills/import/preflight', file)
  }

  /** SKILL-V1.3:SKILL.md Import(multipart;成功 → draft Skill)。 */
  importSkill(file: File): Promise<Skill> {
    return this.uploadFile<Skill>('/api/skills/import', file)
  }

  /** 复用统一 fetch 通道;FormData 不设 content-type(浏览器自动补 boundary)。 */
  private uploadFile<T>(url: string, file: File): Promise<T> {
    const form = new FormData()
    form.append('file', file, file.name)
    return this.request<T>(url, {
      method: 'POST',
      headers: { 'x-csrf-token': csrfToken() },
      body: form,
    })
  }

  publishSkill(id: string): Promise<{ ok: true }> {
    return this.mutate<{ ok: true }>(`/api/skills/${encodeURIComponent(id)}/publish`, 'POST')
  }

  /** 撤回(owner-only;published→draft,已安装副本经投影重建退出 Runtime)。 */
  unpublishSkill(id: string): Promise<{ ok: true }> {
    return this.mutate<{ ok: true }>(`/api/skills/${encodeURIComponent(id)}/unpublish`, 'POST')
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

  /** 上传文档到 KB(纯文本内容上传;txt/md 既有链路)。 */
  uploadDocument(kbId: string, filename: string, content: string): Promise<KbDocument> {
    return this.mutate<KbDocument>(`/api/knowledge-bases/${encodeURIComponent(kbId)}/documents`, 'POST', { filename, content })
  }

  // --- K-T3:Embedding Provider 配置(tenant_admin only) ---
  getEmbeddingConfig(): Promise<EmbeddingConfigView> {
    return this.request<EmbeddingConfigView>('/api/knowledge/embedding-config')
  }

  saveEmbeddingConfig(input: EmbeddingConfigSaveInput): Promise<EmbeddingConfigView> {
    return this.mutate<EmbeddingConfigView>('/api/knowledge/embedding-config', 'PUT', input)
  }

  testEmbeddingConfig(): Promise<EmbeddingTestResult> {
    return this.mutate<EmbeddingTestResult>('/api/knowledge/embedding-config/test', 'POST')
  }

  /** K-T1:PDF/DOCX multipart 上传(同一授权/存储/ingestion 链路;解析失败返回 422 受控错误码)。 */
  async uploadDocumentFile(kbId: string, file: File): Promise<KbDocument> {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(`/api/knowledge-bases/${encodeURIComponent(kbId)}/files`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-csrf-token': csrfToken() },
      body: fd,
    })
    if (!res.ok) throw new PlatformApiError(res.status, await parseErrorCode(res))
    return (await res.json()) as KbDocument
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

  /** 连接测试(启用前探针;失败时也以 200 返回结构化结果,错误消息已脱敏)。 */
  testConnector(id: string): Promise<McpTestResult> {
    return this.mutate<McpTestResult>(`/api/connectors/${encodeURIComponent(id)}/test`, 'POST')
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
