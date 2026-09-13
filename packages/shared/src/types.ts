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
