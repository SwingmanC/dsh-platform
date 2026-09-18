import type { TenantContext, Workspace } from '@dsh-platform/shared'
import { randomUUID } from 'node:crypto'
import { execute, queryMany, queryOne } from '../db.js'

interface WorkspaceRow {
  id: string
  userId: string
  canonicalPath: string
  displayName: string
  lastUsedAt: string | null
  archivedAt: string | null
  missingSince: string | null
}

const COLUMNS = `id, user_id AS userId, canonical_path AS canonicalPath,
  display_name AS displayName, last_used_at AS lastUsedAt, archived_at AS archivedAt,
  missing_since AS missingSince`

export class WorkspaceRepository {
  async listByOwner(ctx: TenantContext): Promise<Array<WorkspaceRow & { exists: boolean }>> {
    const rows = await queryMany<WorkspaceRow>(
      `SELECT ${COLUMNS} FROM t_dsh_workspaces WHERE user_id = ? ORDER BY last_used_at DESC`,
      [ctx.userId],
    )
    return rows.map((r) => ({ ...r, exists: true }))
  }

  async findOwned(ctx: TenantContext, canonicalPath: string): Promise<WorkspaceRow | undefined> {
    return queryOne<WorkspaceRow>(
      `SELECT ${COLUMNS} FROM t_dsh_workspaces WHERE user_id = ? AND canonical_path = ?`,
      [ctx.userId, canonicalPath],
    )
  }

  async findById(ctx: TenantContext, workspaceId: string): Promise<WorkspaceRow | undefined> {
    return queryOne<WorkspaceRow>(
      `SELECT ${COLUMNS} FROM t_dsh_workspaces WHERE id = ? AND user_id = ?`,
      [workspaceId, ctx.userId],
    )
  }

  async upsert(ctx: TenantContext, canonicalPath: string, displayName: string): Promise<WorkspaceRow> {
    const existing = await this.findOwned(ctx, canonicalPath)
    if (existing !== undefined) {
      await execute(
        'UPDATE t_dsh_workspaces SET last_used_at = UTC_TIMESTAMP(3), missing_since = NULL WHERE id = ?',
        [existing.id],
      )
      return { ...existing, missingSince: null }
    }
    const id = randomUUID()
    await execute(
      `INSERT INTO t_dsh_workspaces (id, user_id, canonical_path, display_name, last_used_at)
       VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3))`,
      [id, ctx.userId, canonicalPath, displayName],
    )
    return { id, userId: ctx.userId, canonicalPath, displayName, lastUsedAt: null, archivedAt: null, missingSince: null }
  }

  async markMissing(ctx: TenantContext, workspaceId: string): Promise<void> {
    await execute('UPDATE t_dsh_workspaces SET missing_since = UTC_TIMESTAMP(3) WHERE id = ? AND user_id = ?',
      [workspaceId, ctx.userId])
  }

  async markPresent(ctx: TenantContext, workspaceId: string): Promise<void> {
    await execute('UPDATE t_dsh_workspaces SET missing_since = NULL WHERE id = ? AND user_id = ?',
      [workspaceId, ctx.userId])
  }
}

export const workspaceRepository = new WorkspaceRepository()