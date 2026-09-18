import type { TenantContext } from '@dsh-platform/shared'
import type { SessionListItem } from '@dsh-platform/shared'
import { queryMany, queryOne } from '../db.js'

interface BindingRow {
  sessionId: string
  title: string | null
  workspaceId: string | null
  workspace: string
  status: string
  updatedAt: string
}

export class AgentBindingRepository {
  async listByOwner(ctx: TenantContext): Promise<SessionListItem[]> {
    return queryMany<SessionListItem>(
      `SELECT session_id AS sessionId, title, workspace_id AS workspaceId, workspace,
              updated_at AS updatedAt, status
         FROM t_dsh_agent_bindings
        WHERE user_id = ? AND status = 'active'
        ORDER BY updated_at DESC`,
      [ctx.userId],
    )
  }

  async findOwned(ctx: TenantContext, sessionId: string): Promise<BindingRow | undefined> {
    return queryOne<BindingRow>(
      `SELECT session_id AS sessionId, title, workspace_id AS workspaceId, workspace, status,
              updated_at AS updatedAt
         FROM t_dsh_agent_bindings
        WHERE session_id = ? AND user_id = ?`,
      [sessionId, ctx.userId],
    )
  }
}

export const agentBindingRepository = new AgentBindingRepository()