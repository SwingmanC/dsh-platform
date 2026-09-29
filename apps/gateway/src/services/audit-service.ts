import { AsyncLocalStorage } from 'node:async_hooks'
import type { FastifyRequest } from 'fastify'
import type { AuditResult, AuditSource, TenantContext } from '@dsh-platform/shared'
import { auditRepository, type StoredAuditEvent } from '../repositories/audit-repository.js'
import { sanitizePayload } from './audit-sanitize.js'

export type AuditAction =
  | 'user.create' | 'user.update' | 'user.password.reset' | 'user.delete'
  | 'login.success' | 'login.failed' | 'login.locked' | 'logout'
  | 'runtime.ensure' | 'runtime.start' | 'runtime.ready' | 'runtime.dead' | 'runtime.drain'
  | 'workspace.create' | 'workspace.recreate' | 'workspace.missing' | 'session.enter' | 'session.migrate'
  | 'skill.create' | 'skill.update' | 'skill.publish' | 'skill.install' | 'skill.uninstall' | 'skill.delete'
  | 'connector.create' | 'connector.approve' | 'connector.disable' | 'connector.authorize' | 'connector.revoke' | 'connector.credential.rotate' | 'connector.delete'
  | 'knowledge.create' | 'knowledge.document.upload' | 'knowledge.mount' | 'knowledge.unmount'
  | 'memory.create' | 'memory.delete' | 'memory.promote' | 'projection.sync'
  | 'security.access.denied'

export interface AuditEvent {
  action: AuditAction
  ctx?: TenantContext
  /** Explicit trusted identity for login and system lifecycle events. */
  identity?: { tenantId: string; userId?: string; displayName?: string }
  subject?: string | null
  resourceType?: string
  resourceId?: string | null
  result?: AuditResult
  reasonCode?: string
  source?: AuditSource
  payload?: Record<string, unknown>
}

export const auditRequestContext = new AsyncLocalStorage<{ request?: FastifyRequest; actions: Map<string, AuditResult> }>()
const bounded = (v: string | null | undefined, size: number): string | null => v ? v.slice(0, size) : null

export class AuditService {
  failures = 0
  private pending = 0
  constructor(private readonly repository: Pick<typeof auditRepository, 'insert'> = auditRepository,
    private readonly warn: (data: Record<string, unknown>) => void = (data) => console.warn('[audit] write failed', data)) {}

  async write(event: AuditEvent): Promise<void> {
    try {
      const requestContext = auditRequestContext.getStore()
      const req = event.source === 'system' ? undefined : requestContext?.request
      if (event.source !== 'system') requestContext?.actions.set(event.action, event.result ?? 'SUCCESS')
      const principal = req?.principal
      const tenantId = event.identity?.tenantId ?? event.ctx?.tenantId ?? principal?.tenantId ?? null
      const actor = event.identity?.userId ?? event.ctx?.userId ?? principal?.userId ?? null
      const matchesPrincipal = principal?.tenantId === tenantId && principal?.userId === actor
      const stored: StoredAuditEvent = {
        tenantId, actor,
        actorName: bounded(event.identity?.displayName ?? (matchesPrincipal ? principal?.displayName : null), 128),
        action: event.action,
        resourceType: bounded(event.resourceType ?? event.action.split('.')[0], 64),
        resourceId: bounded(event.resourceId ?? event.subject, 256), subject: bounded(event.subject, 256),
        result: event.result ?? 'SUCCESS', reasonCode: bounded(event.reasonCode, 64),
        requestId: bounded(req?.id ?? event.ctx?.requestId, 128),
        clientIp: bounded(req?.ip, 45), userAgent: bounded(req?.headers['user-agent'], 512),
        source: event.source ?? (req?.url.startsWith('/internal/') ? 'runtime' : req ? 'gateway' : 'system'),
        payload: sanitizePayload(event.payload),
      }
      if (this.pending >= 10) throw new Error('audit-capacity-exceeded')
      this.pending++
      const write = Promise.resolve().then(() => this.repository.insert(stored)).finally(() => { this.pending-- })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([write, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('audit-timeout')), 1500)
        })])
      } finally { if (timer) clearTimeout(timer) }
    } catch {
      this.failures++
      // Never log the SQL exception: it can contain bound parameters.
      try { this.warn({ action: event.action, failures: this.failures }) } catch { /* logging is also best effort */ }
    }
  }
}

export const auditService = new AuditService()

/** Record committed business outcomes; false means no successful mutation. */
export async function auditMutation<T>(ctx: TenantContext, action: AuditAction, resourceId: string | undefined,
  operation: () => Promise<T>, payload?: Record<string, unknown>): Promise<T> {
  try {
    const value = await operation()
    const id = resourceId ?? (typeof value === 'object' && value !== null && 'id' in value ? String(value.id) : undefined)
    await auditService.write({ ctx, action, resourceId: id, result: value === false ? 'DENIED' : 'SUCCESS',
      reasonCode: value === false ? 'not-applied' : undefined, payload })
    return value
  } catch (error) {
    const reason = error instanceof Error ? error.message : ''
    const denied = new Set(['forbidden', 'not-found', 'not-approved', 'connector-inactive', 'knowledge-base-not-found',
      'stdio-disabled-by-policy', 'empty-secret', 'runtime-account-revoked', 'invalid-server-name', 'server-name-collision'])
    await auditService.write({ ctx, action, resourceId, result: denied.has(reason) ? 'DENIED' : 'ERROR',
      reasonCode: denied.has(reason) ? reason : 'operation-failed' })
    throw error
  }
}
