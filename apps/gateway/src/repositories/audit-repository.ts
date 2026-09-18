import type { TenantContext } from '@dsh-platform/shared'
import { execute } from '../db.js'

export type AuditAction =
  | 'login.success' | 'login.failed' | 'login.locked'
  | 'logout'
  | 'runtime.ensure' | 'runtime.start' | 'runtime.ready' | 'runtime.dead' | 'runtime.drain'
  | 'workspace.create' | 'session.enter'
  | 'skill.create' | 'skill.delete'
  | 'connector.create' | 'connector.delete'
  | 'knowledge.create'
  | 'memory.create' | 'memory.delete' | 'memory.promote'

export interface AuditEvent {
  action: AuditAction
  ctx?: TenantContext
  subject?: string | null
  payload?: Record<string, unknown>
}

export class AuditRepository {
  async write(event: AuditEvent): Promise<void> {
    try {
      await execute(
        `INSERT INTO t_dsh_audit_events (tenant_id, actor, action, subject, payload)
         VALUES (?, ?, ?, ?, ?)`,
        [
          event.ctx?.tenantId ?? null,
          event.ctx?.userId ?? null,
          event.action,
          event.subject ?? null,
          event.payload === undefined ? null : JSON.stringify(event.payload),
        ],
      )
    } catch {
      // 审计落库失败不抛出
    }
  }
}

export const auditRepository = new AuditRepository()