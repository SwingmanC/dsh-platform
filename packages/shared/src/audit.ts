export type AuditResult = 'SUCCESS' | 'DENIED' | 'ERROR'
export type AuditSource = 'gateway' | 'runtime' | 'system'

export interface AuditLogItem {
  /** BIGINT identifiers are strings to preserve precision. */
  id: string
  at: string
  actor: string | null
  actorName: string | null
  action: string
  resourceType: string | null
  resourceId: string | null
  subject: string | null
  result: AuditResult | null
  reasonCode: string | null
  requestId: string | null
  clientIp: string | null
  userAgent: string | null
  source: AuditSource | null
  payload: Record<string, unknown> | null
}

export interface AuditListQuery {
  actorName?: string
  actor?: string
  action?: string
  resourceType?: string
  result?: AuditResult
  /** Absolute UTC instants in ISO 8601. */
  from?: string
  to?: string
  page?: number
  pageSize?: number
}

export interface AuditListResponse {
  items: AuditLogItem[]
  total: number
  page: number
  pageSize: number
}
