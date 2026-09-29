import type { AuditListQuery, AuditListResponse, AuditLogItem, AuditResult, AuditSource } from '@dsh-platform/shared'
import mysql from 'mysql2/promise'
import { config } from '../config.js'
import { queryMany, type SqlValue } from '../db.js'
import { sanitizePayload } from '../services/audit-sanitize.js'

// Audit writes have a separate bounded pool so stalled writes cannot occupy business connections.
const auditPool = mysql.createPool({ ...config.mysql, charset: 'utf8mb4', connectionLimit: 2,
  queueLimit: 8, connectTimeout: 1500, maxIdle: 2, idleTimeout: 60000 })
async function writeAudit(sql: string, params: SqlValue[] = []): Promise<number> {
  const [result] = await auditPool.execute<mysql.ResultSetHeader>({ sql, timeout: 1500 }, params)
  return result.affectedRows
}
export async function closeAuditWriter(): Promise<void> { await auditPool.end() }

export interface StoredAuditEvent {
  tenantId: string | null
  actor: string | null
  actorName: string | null
  action: string
  resourceType: string | null
  resourceId: string | null
  subject: string | null
  result: AuditResult
  reasonCode: string | null
  requestId: string | null
  clientIp: string | null
  userAgent: string | null
  source: AuditSource
  payload: Record<string, unknown> | null
}

const COLUMNS = `CAST(id AS CHAR) AS id, DATE_FORMAT(at, '%Y-%m-%dT%H:%i:%s.%fZ') AS at,
  actor, actor_name AS actorName, action, resource_type AS resourceType, resource_id AS resourceId,
  subject, result, reason_code AS reasonCode, request_id AS requestId, client_ip AS clientIp,
  user_agent AS userAgent, source, payload`

export function auditWhere(tenantId: string, q: AuditListQuery): { sql: string; params: SqlValue[] } {
  if (!tenantId) throw new Error('audit-scope-required')
  const clauses = ['tenant_id = ?']
  const params: SqlValue[] = [tenantId]
  for (const [field, value] of [['actor', q.actor], ['action', q.action], ['resource_type', q.resourceType], ['result', q.result]]) {
    if (value) { clauses.push(`${field} = ?`); params.push(value) }
  }
  if (q.actorName) { clauses.push('LOCATE(?, actor_name) > 0'); params.push(q.actorName) }
  for (const [op, value] of [['>=', q.from], ['<=', q.to]]) {
    if (value) { clauses.push(`at ${op} ?`); params.push(new Date(value).toISOString().slice(0, 23).replace('T', ' ')) }
  }
  return { sql: clauses.join(' AND '), params }
}

function safeItem(row: AuditLogItem): AuditLogItem {
  let payload: unknown = row.payload
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload) } catch { payload = null }
  }
  // Legacy rows predate centralized sanitization; never return their raw details.
  return { ...row, id: String(row.id), payload: sanitizePayload(payload) }
}

export class AuditRepository {
  constructor(private readonly writer = writeAudit, private readonly reader = queryMany) {}

  async insert(event: StoredAuditEvent): Promise<void> {
    await this.writer(`INSERT INTO t_dsh_audit_events
      (tenant_id, actor, actor_name, action, resource_type, resource_id, subject, result,
       reason_code, request_id, client_ip, user_agent, source, payload, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
    [event.tenantId, event.actor, event.actorName, event.action, event.resourceType, event.resourceId,
      event.subject, event.result, event.reasonCode, event.requestId, event.clientIp, event.userAgent,
      event.source, event.payload === null ? null : JSON.stringify(event.payload)])
  }

  async list(tenantId: string, q: AuditListQuery): Promise<AuditListResponse> {
    const where = auditWhere(tenantId, q)
    const page = q.page ?? 1
    const pageSize = q.pageSize ?? 20
    const count = await this.reader<{ total: number }>(`SELECT COUNT(*) AS total FROM t_dsh_audit_events WHERE ${where.sql}`, where.params)
    const rows = await this.reader<AuditLogItem>(`SELECT ${COLUMNS} FROM t_dsh_audit_events WHERE ${where.sql}
      ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`, [...where.params, pageSize, (page - 1) * pageSize])
    return { items: rows.map(safeItem), total: Number(count[0]?.total ?? 0), page, pageSize }
  }

  async find(tenantId: string, id: string): Promise<AuditLogItem | null> {
    if (!tenantId) throw new Error('audit-scope-required')
    const rows = await this.reader<AuditLogItem>(`SELECT ${COLUMNS} FROM t_dsh_audit_events WHERE tenant_id = ? AND id = ? LIMIT 1`, [tenantId, id])
    return rows[0] ? safeItem(rows[0]) : null
  }
}

export const auditRepository = new AuditRepository()
