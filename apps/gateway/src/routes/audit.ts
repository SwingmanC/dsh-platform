import type { FastifyInstance } from 'fastify'
import type { AuditListQuery, AuditResult } from '@dsh-platform/shared'
import { auditRepository } from '../repositories/audit-repository.js'

export function parseAuditQuery(input: unknown): AuditListQuery {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('invalid-audit-query')
  const raw = input as Record<string, unknown>
  const allowed = new Set(['actorName', 'actor', 'action', 'resourceType', 'result', 'from', 'to', 'page', 'pageSize'])
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw new Error('invalid-audit-query')
  const q: AuditListQuery = {}
  for (const key of ['actor', 'action', 'resourceType'] as const) {
    const v = raw[key]
    if (v === undefined || v === '') continue
    if (typeof v !== 'string' || v.length > 64 || !/^[\w.-]+$/.test(v)) throw new Error('invalid-audit-query')
    q[key] = v
  }
  if (raw.actorName !== undefined && raw.actorName !== '') {
    if (typeof raw.actorName !== 'string' || raw.actorName.length > 128) throw new Error('invalid-audit-query')
    q.actorName = raw.actorName.trim()
  }
  if (raw.result !== undefined && raw.result !== '') {
    if (!['SUCCESS', 'DENIED', 'ERROR'].includes(String(raw.result)) || typeof raw.result !== 'string') throw new Error('invalid-audit-query')
    q.result = raw.result as AuditResult
  }
  for (const key of ['from', 'to'] as const) {
    const v = raw[key]
    if (v === undefined || v === '') continue
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v) || !Number.isFinite(Date.parse(v))) throw new Error('invalid-audit-query')
    const normalized = new Date(v).toISOString()
    // Date.parse normalizes impossible days; reject those explicitly.
    if (normalized.slice(0, 19) !== v.slice(0, 19)) throw new Error('invalid-audit-query')
    q[key] = normalized
  }
  if (q.from && q.to && q.from > q.to) throw new Error('invalid-audit-query')
  for (const [key, fallback, max] of [['page', 1, 100000], ['pageSize', 20, 100]] as const) {
    const v = raw[key] ?? fallback
    if ((typeof v !== 'string' && typeof v !== 'number') || !/^\d+$/.test(String(v))) throw new Error('invalid-audit-query')
    const n = Number(v)
    if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error('invalid-audit-query')
    q[key] = n
  }
  return q
}

export function registerAuditRoutes(app: FastifyInstance, repository: Pick<typeof auditRepository, 'list' | 'find'> = auditRepository): void {
  app.get('/api/audit/events', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    if (req.principal.role !== 'tenant_admin') return reply.code(404).send({ error: 'not-found' })
    let query: AuditListQuery
    try { query = parseAuditQuery(req.query) } catch { return reply.code(400).send({ error: 'invalid-audit-query' }) }
    try { return await repository.list(req.principal.tenantId, query) } catch {
      req.log.error({ requestId: req.id }, 'audit query failed')
      return reply.code(500).send({ error: 'audit-query-failed' })
    }
  })
  app.get('/api/audit/events/:id', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    if (req.principal.role !== 'tenant_admin') return reply.code(404).send({ error: 'not-found' })
    const id = (req.params as { id: string }).id
    if (!/^[1-9]\d{0,19}$/.test(id) || BigInt(id) > 18446744073709551615n) return reply.code(404).send({ error: 'not-found' })
    try {
      const item = await repository.find(req.principal.tenantId, id)
      return item ?? reply.code(404).send({ error: 'not-found' })
    } catch {
      req.log.error({ requestId: req.id }, 'audit detail failed')
      return reply.code(500).send({ error: 'audit-query-failed' })
    }
  })
}
