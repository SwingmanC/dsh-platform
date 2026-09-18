import { execute } from './db.js'

/** 审计动作(platform 设计 §7/§10)。 */
export type AuditAction =
  | 'login'
  | 'login.failed'
  | 'login.locked'
  | 'logout'
  | 'session.enter'
  | 'workspace.missing'
  | 'workspace.recreate'
  | 'session.migrate'
  | 'runtime.spawn'
  | 'runtime.spawn.failed'
  | 'runtime.exit'
  | 'proxy.error'

export interface AuditEvent {
  action: AuditAction
  tenantId?: string | null
  actor?: string | null
  subject?: string | null
  payload?: Record<string, unknown>
}

/**
 * 写入 t_dsh_audit_events。审计失败绝不阻断业务请求(仅记录到调用方日志)。
 * 明文凭据不得进入 payload(安全基线)。
 */
export async function audit(event: AuditEvent): Promise<void> {
  try {
    await execute(
      `INSERT INTO t_dsh_audit_events (tenant_id, actor, action, subject, payload)
       VALUES (?, ?, ?, ?, ?)`,
      [
        event.tenantId ?? null,
        event.actor ?? null,
        event.action,
        event.subject ?? null,
        event.payload === undefined ? null : JSON.stringify(event.payload),
      ],
    )
  } catch {
    // 审计落库失败不抛出:调用方负责日志。
  }
}
