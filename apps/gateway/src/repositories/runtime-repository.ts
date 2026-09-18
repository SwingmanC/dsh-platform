import type { TenantContext, RuntimeRecord } from '@dsh-platform/shared'
import { execute, queryOne } from '../db.js'

export class RuntimeRepository {
  async recordStart(runtimeId: string, ctx: TenantContext, host: string, dshVersion: string, pid: number | null): Promise<void> {
    await execute(
      `INSERT INTO t_dsh_runtimes (id, user_id, host, dsh_version, state, last_heartbeat, pid)
       VALUES (?, ?, ?, ?, 'starting', UTC_TIMESTAMP(3), ?)
       ON DUPLICATE KEY UPDATE state = 'starting', last_heartbeat = UTC_TIMESTAMP(3), pid = VALUES(pid)`,
      [runtimeId, ctx.userId, host, dshVersion, pid],
    )
  }

  async updateState(runtimeId: string, state: string): Promise<void> {
    await execute(
      'UPDATE t_dsh_runtimes SET state = ?, last_heartbeat = UTC_TIMESTAMP(3) WHERE id = ?',
      [state, runtimeId],
    )
  }

  async touchHeartbeat(runtimeId: string): Promise<void> {
    await execute('UPDATE t_dsh_runtimes SET last_heartbeat = UTC_TIMESTAMP(3) WHERE id = ?', [runtimeId])
  }

  async findActive(ctx: TenantContext): Promise<RuntimeRecord | undefined> {
    return queryOne<RuntimeRecord>(
      `SELECT id, user_id AS userId, host, dsh_version AS dshVersion, state, last_heartbeat AS lastHeartbeat, pid
         FROM t_dsh_runtimes WHERE user_id = ? AND state IN ('starting','ready') ORDER BY last_heartbeat DESC LIMIT 1`,
      [ctx.userId],
    )
  }
}

export const runtimeRepository = new RuntimeRepository()