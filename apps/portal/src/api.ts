import type {
  LoginResponse,
  MeResponse,
  SessionEnterResult,
  SessionListResponse,
  Workspace,
  WorkspaceListResponse,
} from '@dsh-platform/shared'

/** 读取 CSRF 双提交 token(csrf_token cookie 由网关下发,非 HttpOnly)。 */
function csrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/)
  return match?.[1] === undefined ? '' : decodeURIComponent(match[1])
}

async function parseError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string }
  return data.code ?? data.error ?? `http-${res.status}`
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: { accept: 'application/json', ...(init?.headers as Record<string, string> | undefined) },
  })
  if (!res.ok) throw new Error(await parseError(res))
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** 写操作:仅在有请求体时携带 content-type,避免 Fastify 对空 JSON body 返回 400。 */
function mutate<T>(url: string, method: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-csrf-token': csrfToken() }
  if (body !== undefined) headers['content-type'] = 'application/json'
  return request<T>(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

// --- Auth ---
export async function getMe(): Promise<MeResponse | null> {
  const res = await fetch('/auth/me', { credentials: 'include', headers: { accept: 'application/json' } })
  if (res.status === 401) return null
  if (!res.ok) throw new Error(`auth/me failed: ${res.status}`)
  return (await res.json()) as MeResponse
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  return mutate<LoginResponse>('/auth/login', 'POST', { email, password })
}

export async function logout(): Promise<void> {
  await fetch('/auth/logout', {
    method: 'POST',
    credentials: 'include',
    headers: { 'x-csrf-token': csrfToken() },
    redirect: 'manual',
  })
}

// --- Workspaces ---
export function listWorkspaces(): Promise<WorkspaceListResponse> {
  return request<WorkspaceListResponse>('/api/workspaces')
}

export function createWorkspace(name: string): Promise<Workspace> {
  return mutate<Workspace>('/api/workspaces', 'POST', { name })
}

export function recreateWorkspace(sessionId: string): Promise<{ ok: true; redirectUrl: string }> {
  return mutate<{ ok: true; redirectUrl: string }>('/api/workspaces/recreate', 'POST', { sessionId })
}

// --- Sessions ---
export function listSessions(): Promise<SessionListResponse> {
  return request<SessionListResponse>('/api/sessions')
}

export function enterSession(sessionId: string): Promise<SessionEnterResult> {
  return mutate<SessionEnterResult>('/api/sessions/enter', 'POST', { sessionId })
}

// --- Memory ---
export interface MemoryRecord {
  id: string; content: string; visibility: 'personal' | 'tenant_shared'
  sourceType: string; namespace: string; reviewStatus: string
  createdAt: string; updatedAt: string
}
export function listMemory(visibility?: string): Promise<{ records: MemoryRecord[]; total: number }> {
  const qs = visibility ? `?visibility=${visibility}&limit=50` : '?limit=50'
  return request(`/api/memory${qs}`)
}
export function createMemory(content: string): Promise<MemoryRecord> {
  return mutate<MemoryRecord>('/api/memory', 'POST', { content })
}
export function deleteMemory(id: string): Promise<{ ok: true }> {
  return mutate<{ ok: true }>(`/api/memory/${id}`, 'DELETE')
}
export function promoteMemory(id: string): Promise<{ ok: true }> {
  return mutate<{ ok: true }>(`/api/memory/${id}/promote`, 'POST', { targetVisibility: 'tenant_shared' })
}

// --- Skills ---
export interface Skill {
  id: string; name: string; slug: string; description: string | null
  visibility: 'private' | 'tenant' | 'public'; status: string
  latestVersion: string; category: string | null; installCount: number
  creatorId: string; updatedAt: string
}
export function listSkills(q?: string): Promise<{ skills: Skill[]; total: number }> {
  return request(`/api/skills${q ? `?q=${encodeURIComponent(q)}` : ''}`)
}
export function listInstalledSkills(): Promise<{ skills: Skill[] }> {
  return request('/api/skills/installed')
}
export function createSkill(name: string, description: string, prompt: string): Promise<Skill> {
  return mutate<Skill>('/api/skills', 'POST', { name, description, prompt })
}
export function publishSkill(id: string): Promise<{ ok: true }> {
  return mutate<{ ok: true }>(`/api/skills/${id}/publish`, 'POST')
}
export function installSkill(id: string): Promise<{ ok: true }> {
  return mutate<{ ok: true }>(`/api/skills/${id}/install`, 'POST')
}
export function uninstallSkill(id: string): Promise<{ ok: true }> {
  return mutate<{ ok: true }>(`/api/skills/${id}/install`, 'DELETE')
}

// --- Knowledge ---
export interface KnowledgeBase {
  id: string; name: string; description: string | null
  visibility: 'personal' | 'tenant'; category: string | null; docCount: number
  status: string; updatedAt: string
}
export function listKnowledgeBases(): Promise<{ knowledgeBases: KnowledgeBase[] }> {
  return request('/api/knowledge-bases')
}
export function createKnowledgeBase(name: string, visibility: string): Promise<KnowledgeBase> {
  return mutate<KnowledgeBase>('/api/knowledge-bases', 'POST', { name, visibility })
}
export function listKbDocuments(kbId: string): Promise<{ documents: Array<{ id: string; filename: string; fileSize: number; status: string }> }> {
  return request(`/api/knowledge-bases/${kbId}/documents`)
}
export function mountKnowledgeBase(kbId: string): Promise<{ ok: true }> {
  return mutate<{ ok: true }>(`/api/knowledge-bases/${kbId}/mount`, 'POST')
}
export function listMounts(): Promise<{ mounts: KnowledgeBase[] }> {
  return request('/api/knowledge/mounts')
}

// --- MCP ---
export interface MCPConnector {
  id: string; name: string; serverName: string; transport: 'stdio' | 'streamable-http'
  scope: string; status: string; riskLevel: string; toolCount: number
  approved: boolean; endpointUrl: string | null; updatedAt: string
}
export function listConnectors(): Promise<{ connectors: MCPConnector[] }> {
  return request('/api/connectors')
}
export function createConnector(input: { name: string; serverName: string; transport: string; endpointUrl?: string; command?: string }): Promise<MCPConnector> {
  return mutate<MCPConnector>('/api/connectors', 'POST', input)
}
export function approveConnector(id: string): Promise<{ ok: true }> {
  return mutate<{ ok: true }>(`/api/connectors/${id}/approve`, 'POST')
}
export function authorizeConnector(id: string): Promise<{ ok: true }> {
  return mutate<{ ok: true }>(`/api/connectors/${id}/authorize`, 'POST')
}
export function listAuthorizedConnectors(): Promise<{ connectors: MCPConnector[] }> {
  return request('/api/connectors/authorized')
}
