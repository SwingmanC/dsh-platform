/**
 * 平台 API DTO 镜像(与 `@dsh-platform/shared` 保持一致)。
 *
 * 客户端 bundle 不能依赖 workspace 包(不在官方 module table baseline),
 * 因此这里镜像所需字段。真源:packages/shared/src/types.ts。
 */

export type SkillVisibility = 'private' | 'tenant' | 'public'
export type SkillStatus = 'draft' | 'pending_review' | 'published' | 'rejected' | 'suspended' | 'deprecated'

export interface Skill {
  id: string
  tenantId: string
  creatorId: string
  name: string
  slug: string
  description: string | null
  prompt: string | null
  whenToUse?: string | null
  modelInvocable?: boolean
  userInvocable?: boolean
  visibility: SkillVisibility
  status: SkillStatus
  latestVersion: string
  category: string | null
  usageCount: number
  installCount: number
  createdAt: string
  updatedAt: string
  /** SKILL-V1.1:当前请求者是否为 creator(服务端计算)。 */
  isOwner?: boolean
}

export interface SkillListResult {
  skills: Skill[]
  total: number
}

/** SKILL-V1.3:SKILL.md Import preflight 预览(valid=false 时 canonical 字段为 null)。 */
export interface SkillImportPreflight {
  valid: boolean
  name: string | null
  description: string | null
  whenToUse: string | null
  modelInvocable: boolean | null
  userInvocable: boolean | null
  warnings: string[]
  errors: string[]
}

export type KbVisibility = 'personal' | 'tenant'
export type DocStatus = 'uploaded' | 'parsing' | 'chunking' | 'ready' | 'failed' | 'archived'

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
  fileSize: number
  contentType: string | null
  status: DocStatus
  currentVersion: number
  createdAt: string
  updatedAt: string
}

export interface CitationMeta {
  citationId: string
  kbId: string
  documentId: string
  documentVersionId: string
  chunkId: string
  chunkIndex: number
  documentTitle: string
}

export interface KbChunk {
  id: string
  docId: string
  kbId: string
  chunkIndex: number
  content: string
  tokenCount: number | null
  createdAt: string
  citation?: CitationMeta
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
  approved: boolean
  approvedBy: string | null
  lastTestAt: string | null
  createdAt: string
  updatedAt: string
  /** MCP-V1.1:最后一次成功 discovery 的工具目录(管理面展示;非授权策略)。 */
  discoveredTools?: Array<{
    name: string
    description: string | null
    inputSchema: Record<string, unknown>
  }>
}

export type MemoryVisibility = 'personal' | 'tenant_shared'
export type MemoryKind = 'preference' | 'fact' | 'decision' | 'instruction' | 'other'
export type MemoryExtractionMode = 'manual' | 'explicit_user' | 'llm'
export type MemorySourceType = 'user_fact' | 'model_inferred' | 'imported' | 'team_approved'
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

export interface MemorySearchResult {
  records: MemoryRecord[]
  total: number
}

/** 统一错误响应(网关)。 */
export interface ApiErrorBody {
  error?: string
  code?: string
}
