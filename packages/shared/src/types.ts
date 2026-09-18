/**
 * db/schema.sql 中 t_dsh_* 表的实体镜像。
 * 时间字段是应用层写入的 UTC 值(mysql2 dateStrings 下为字符串,毫秒精度)。
 */
export type UtcTimestamp = string

export interface Tenant {
  id: string
  slug: string
  name: string
  plan: string
  /** 模型白名单、工具白名单、审批策略、沙箱模式(结构随 P2 固化)。 */
  settings: unknown
  createdAt: UtcTimestamp
}

export type UserRole = 'tenant_admin' | 'operator' | 'member'
export type UserStatus = 'active' | 'disabled'

export interface User {
  id: string
  tenantId: string
  /** OIDC subject;本地账号形态为 null。 */
  externalSub: string | null
  email: string
  displayName: string
  role: UserRole
  status: UserStatus
  createdAt: UtcTimestamp
}

export interface Workspace {
  id: string
  userId: string
  /** 规范化绝对路径(会话的 cwd 归属)。 */
  canonicalPath: string
  displayName: string
  lastUsedAt: UtcTimestamp | null
  archivedAt: UtcTimestamp | null
  /** 巡检发现缺失的时间;null = 目录在。 */
  missingSince: UtcTimestamp | null
}

export type BindingStatus = 'active' | 'archived'

/** dsh SessionId ↔ 外部身份的映射(权威在网关,不在请求路径上)。 */
export interface AgentBinding {
  sessionId: string
  tenantId: string
  userId: string
  /** 当前持有写句柄的 runtime 进程。 */
  runtimeId: string | null
  title: string | null
  /** 该会话的 cwd(绝对路径)。 */
  workspace: string
  workspaceId: string | null
  /** S2 迁移的源会话 id。 */
  migratedFrom: string | null
  status: BindingStatus
  createdAt: UtcTimestamp
  updatedAt: UtcTimestamp
}

export type RuntimeState = 'starting' | 'ready' | 'draining' | 'dead'

export interface RuntimeRecord {
  id: string
  userId: string
  host: string
  /** 钉住的 dsh 版本(dev preview,必须锁版本)。 */
  dshVersion: string
  state: RuntimeState
  lastHeartbeat: UtcTimestamp
  pid: number | null
}

export type QuotaKind = 'concurrent_runtimes' | 'sessions' | 'daily_tokens'

/**
 * 已认证用户的主体信息(由 Gateway 在认证后注入,所有 handler 以此为准)。
 * 禁止从 body/query/header 读取 userId。
 */
export interface AuthenticatedPrincipal {
  tenantId: string
  userId: string
  role: UserRole
  displayName: string
  sessionId: string
  deviceId: string
  /** 当 AuthenticatedPrincipal 用作 TenantContext 时填充 */
  requestId?: string
  platformSessionId?: string
}

/**
 * 服务层上下文:显式传递给所有 Repository/Service 方法。
 * 确保 tenant/user 过滤不会遗漏。
 */
export interface TenantContext {
  tenantId: string
  userId: string
  role: UserRole
  requestId: string
  platformSessionId: string
  deviceId: string
}

/** Memory 可见范围 */
export type MemoryVisibility = 'personal' | 'tenant_shared'

/** Memory 类型(Phase 07) */
export type MemoryKind = 'preference' | 'fact' | 'decision' | 'instruction' | 'other'

/** Memory 提取模式(Phase 07) */
export type MemoryExtractionMode = 'manual' | 'explicit_user' | 'llm'

/** Memory 来源类型 */
export type MemorySourceType = 'user_fact' | 'model_inferred' | 'imported' | 'team_approved'

/** Memory 审核状态 */
export type MemoryReviewStatus = 'pending' | 'approved' | 'rejected'

export interface MemoryRecord {
  id: string
  tenantId: string
  ownerUserId: string
  namespace: string
  content: string
  kind: MemoryKind
  visibility: MemoryVisibility
  sourceType: MemorySourceType
  sourceSessionId: string | null
  sourceEventSeq: number | null
  confidence: number | null
  revision: number
  supersededBy: string | null
  extractionMode: MemoryExtractionMode
  reviewStatus: MemoryReviewStatus
  reviewedBy: string | null
  createdAt: string
  updatedAt: string
}

export interface MemorySearchInput {
  query: string
  namespace?: string
  kind?: MemoryKind
  visibility?: MemoryVisibility
  limit?: number
  offset?: number
}

export interface MemorySearchResult {
  records: MemoryRecord[]
  total: number
}

export interface PromoteMemoryInput {
  memoryId: string
  targetVisibility: MemoryVisibility
  reason?: string
}

/** Skill 可见范围 */
export type SkillVisibility = 'private' | 'tenant' | 'public'

/** Skill 状态 */
export type SkillStatus = 'draft' | 'pending_review' | 'published' | 'rejected' | 'suspended' | 'deprecated'

export interface Skill {
  id: string
  tenantId: string
  creatorId: string
  name: string
  slug: string
  description: string | null
  prompt: string | null
  tools: unknown
  visibility: SkillVisibility
  status: SkillStatus
  latestVersion: string
  category: string | null
  sourceType: string | null
  sourceUrl: string | null
  usageCount: number
  installCount: number
  createdAt: string
  updatedAt: string
}

export interface SkillVersion {
  id: string
  skillId: string
  version: string
  prompt: string
  tools: unknown
  manifest: unknown
  contentHash: string | null
  packageLocation: string | null
  sourceCommit: string | null
  createdAt: string
}

export interface SkillInstallation {
  id: string
  tenantId: string
  userId: string
  skillId: string
  version: string
  enabled: boolean
  installedAt: string
}

export interface SkillSearchInput {
  q?: string
  visibility?: SkillVisibility
  category?: string
  status?: SkillStatus
  limit?: number
  offset?: number
}

export type KbVisibility = 'personal' | 'tenant'
export type KbPermission = 'read' | 'propose' | 'write' | 'admin'
export type DocStatus = 'uploaded' | 'parsing' | 'chunking' | 'ready' | 'failed' | 'archived'
export type IngestionStatus = 'pending' | 'parsing' | 'chunking' | 'ready' | 'failed'

export interface KnowledgeBase {
  id: string
  tenantId: string
  creatorId: string
  name: string
  description: string | null
  visibility: KbVisibility
  category: string | null
  docCount: number
  status: string
  createdAt: string
  updatedAt: string
}

export interface KbDocument {
  id: string
  kbId: string
  filename: string
  filepath: string
  fileSize: number
  contentType: string | null
  status: DocStatus
  currentVersion: number
  createdAt: string
  updatedAt: string
}

export interface KbChunk {
  id: string
  docId: string
  kbId: string
  chunkIndex: number
  content: string
  tokenCount: number | null
  createdAt: string
}

export interface KbSearchInput {
  q: string
  kbId?: string
  limit?: number
  offset?: number
}

export interface KbSearchResult {
  chunks: KbChunk[]
  total: number
}

export type MCPTransport = 'stdio' | 'streamable-http'
export type MCPScope = 'user' | 'tenant' | 'platform'
export type MCPRiskLevel = 'low' | 'medium' | 'high'

export interface MCPConnector {
  id: string
  tenantId: string
  creatorId: string
  name: string
  description: string | null
  serverName: string
  transport: MCPTransport
  scope: MCPScope
  visibility: string
  status: string
  riskLevel: MCPRiskLevel
  toolCount: number
  command: string | null
  endpointUrl: string | null
  authType: string | null
  credentialRef: string | null
  approved: boolean
  approvedBy: string | null
  lastTestAt: string | null
  createdAt: string
  updatedAt: string
}
