import type { TenantContext, MCPConnector, MCPTransport, MCPScope, MCPRiskLevel } from '@dsh-platform/shared'
import type { SqlValue } from '../db.js'
import { randomUUID } from 'node:crypto'
import { execute, queryMany, queryOne } from '../db.js'

interface McpRow { id: string; tenantId: string; creatorId: string; name: string; description: string | null; serverName: string; transport: string; scope: string; visibility: string; status: string; riskLevel: string; toolCount: number; command: string | null; endpointUrl: string | null; authType: string | null; credentialRef: string | null; approved: number; approvedBy: string | null; lastTestAt: string | null; createdAt: string; updatedAt: string }
const COLS = `id, tenant_id AS tenantId, creator_id AS creatorId, name, description,
  server_name AS serverName, transport, scope, visibility, status,
  risk_level AS riskLevel, tool_count AS toolCount, command,
  endpoint_url AS endpointUrl, auth_type AS authType, credential_ref AS credentialRef,
  approved, approved_by AS approvedBy, last_test_at AS lastTestAt,
  created_at AS createdAt, updated_at AS updatedAt`

/** 投影所需的 connector 行(含 projection 决策字段)。 */
export interface ProjectableConnector {
  id: string; tenantId: string; creatorId: string; name: string
  serverName: string; transport: string; status: string; approved: number
  endpointUrl: string | null; authType: string | null
}

function toConnector(r: McpRow): MCPConnector {
  return { ...r, transport: r.transport as MCPTransport, scope: r.scope as MCPScope, riskLevel: r.riskLevel as MCPRiskLevel, approved: r.approved === 1, toolCount: r.toolCount ?? 0 }
}

export class MCPRepository {
  async list(ctx: TenantContext): Promise<MCPConnector[]> {
    const rows = await queryMany<McpRow>(
      `SELECT ${COLS} FROM t_dsh_mcp_connectors
       WHERE creator_id = ? OR scope = 'tenant' AND tenant_id = ? OR scope = 'platform'
       ORDER BY updated_at DESC`, [ctx.userId, ctx.tenantId])
    return rows.map(toConnector)
  }

  async findById(ctx: TenantContext, id: string): Promise<MCPConnector | undefined> {
    const row = await queryOne<McpRow>(
      `SELECT ${COLS} FROM t_dsh_mcp_connectors WHERE id = ? AND (creator_id = ? OR scope = 'tenant' AND tenant_id = ? OR scope = 'platform')`,
      [id, ctx.userId, ctx.tenantId])
    return row ? toConnector(row) : undefined
  }

  /** 无 visibility 过滤的原始行(仅服务端授权/投影内部使用,不暴露给请求路径)。 */
  async findRawById(id: string): Promise<McpRow | undefined> {
    return queryOne<McpRow>(`SELECT ${COLS} FROM t_dsh_mcp_connectors WHERE id = ?`, [id])
  }

  async findOwned(ctx: TenantContext, id: string): Promise<MCPConnector | undefined> {
    const row = await queryOne<McpRow>(`SELECT ${COLS} FROM t_dsh_mcp_connectors WHERE id = ? AND creator_id = ?`, [id, ctx.userId])
    return row ? toConnector(row) : undefined
  }

  async create(ctx: TenantContext, data: {
    name: string; serverName: string; transport: MCPTransport; scope?: MCPScope; riskLevel?: MCPRiskLevel;
    command?: string; endpointUrl?: string; authType?: string; credentialRef?: string; visibility?: string
  }): Promise<MCPConnector> {
    const id = randomUUID()
    await execute(
      `INSERT INTO t_dsh_mcp_connectors (id, tenant_id, creator_id, name, server_name, transport, scope, visibility, risk_level, command, endpoint_url, auth_type, credential_ref, status, approved)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0)`,
      [id, ctx.tenantId, ctx.userId, data.name, data.serverName, data.transport, data.scope ?? 'user',
       data.visibility ?? 'private', data.riskLevel ?? 'low', data.command ?? null,
       data.endpointUrl ?? null, data.authType ?? null, data.credentialRef ?? null])
    return this.findById(ctx, id) as unknown as MCPConnector
  }

  /** 服务端审批(权限由 service 层校验;此处只写状态)。 */
  async approve(id: string, approvedBy: string): Promise<boolean> {
    const affected = await execute(
      `UPDATE t_dsh_mcp_connectors SET approved = 1, approved_by = ?, status = 'active' WHERE id = ?`,
      [approvedBy, id])
    return affected > 0
  }

  async disable(ctx: TenantContext, id: string): Promise<boolean> {
    const affected = await execute(
      `UPDATE t_dsh_mcp_connectors SET status = 'disabled' WHERE id = ? AND creator_id = ?`,
      [id, ctx.userId])
    return affected > 0
  }

  async authorize(ctx: TenantContext, connectorId: string): Promise<boolean> {
    const authId = randomUUID()
    await execute(
      `INSERT INTO t_dsh_mcp_authorizations (id, connector_id, user_id, approved) VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE approved = 1`,
      [authId, connectorId, ctx.userId])
    return true
  }

  async revoke(ctx: TenantContext, connectorId: string): Promise<boolean> {
    const affected = await execute(
      `DELETE FROM t_dsh_mcp_authorizations WHERE connector_id = ? AND user_id = ?`,
      [connectorId, ctx.userId])
    return affected > 0
  }

  async isAuthorized(ctx: TenantContext, connectorId: string): Promise<boolean> {
    const row = await queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM t_dsh_mcp_authorizations WHERE connector_id = ? AND user_id = ? AND approved = 1`,
      [connectorId, ctx.userId])
    return (row?.cnt ?? 0) > 0
  }

  async listAuthorizedIds(userId: string): Promise<string[]> {
    const rows = await queryMany<{ connectorId: string }>(
      `SELECT connector_id AS connectorId FROM t_dsh_mcp_authorizations WHERE user_id = ? AND approved = 1`, [userId])
    return rows.map((r) => r.connectorId)
  }

  /** 是否有任意用户授权该 connector(approve/disable 后需刷新这些用户投影)。 */
  async listAuthorizedUserIds(connectorId: string): Promise<Array<{ userId: string; tenantId: string }>> {
    return queryMany<{ userId: string; tenantId: string }>(
      `SELECT a.user_id AS userId, c.tenant_id AS tenantId
         FROM t_dsh_mcp_authorizations a
         JOIN t_dsh_mcp_connectors c ON c.id = a.connector_id
        WHERE a.connector_id = ? AND a.approved = 1`, [connectorId])
  }

  /**
   * 可进入 Runtime 投影的 connector:当前用户已授权 + approved + active + 配置完整。
   * 安全边界在 SQL;transport policy / credential 在 service 层二次判定。
   */
  async listProjectableAuthorized(userId: string, tenantId: string): Promise<ProjectableConnector[]> {
    return queryMany<ProjectableConnector>(
      `SELECT c.id, c.tenant_id AS tenantId, c.creator_id AS creatorId, c.name,
              c.server_name AS serverName, c.transport, c.status, c.approved,
              c.endpoint_url AS endpointUrl, c.auth_type AS authType
         FROM t_dsh_mcp_connectors c
         JOIN t_dsh_mcp_authorizations a ON a.connector_id = c.id AND a.user_id = ? AND a.approved = 1
        WHERE c.approved = 1 AND c.status = 'active'
          AND (c.creator_id = ? OR c.scope = 'tenant' AND c.tenant_id = ? OR c.scope = 'platform')
        ORDER BY c.server_name`, [userId, userId, tenantId])
  }

  // --- Credentials(只存加密 envelope) ---

  async putCredential(tenantId: string, connectorId: string, envelope: string): Promise<void> {
    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM t_dsh_mcp_credentials WHERE connector_id = ?`, [connectorId])
    if (existing) {
      await execute(
        `UPDATE t_dsh_mcp_credentials SET ciphertext = ?, rotated_at = UTC_TIMESTAMP(3) WHERE connector_id = ?`,
        [Buffer.from(envelope, 'utf8'), connectorId])
    } else {
      await execute(
        `INSERT INTO t_dsh_mcp_credentials (id, tenant_id, connector_id, ciphertext, rotated_at)
         VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3))`,
        [randomUUID(), tenantId, connectorId, Buffer.from(envelope, 'utf8')])
    }
    await execute(`UPDATE t_dsh_mcp_connectors SET auth_type = COALESCE(auth_type, 'bearer') WHERE id = ?`, [connectorId])
  }

  async getCredentialEnvelope(connectorId: string): Promise<string | null> {
    const row = await queryOne<{ ciphertext: Buffer | string }>(
      `SELECT ciphertext FROM t_dsh_mcp_credentials WHERE connector_id = ?`, [connectorId])
    if (!row) return null
    const buf = row.ciphertext
    return typeof buf === 'string' ? buf : buf.toString('utf8')
  }

  async hasCredential(connectorId: string): Promise<boolean> {
    const row = await queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM t_dsh_mcp_credentials WHERE connector_id = ?`, [connectorId])
    return (row?.cnt ?? 0) > 0
  }

  async deleteCredential(connectorId: string): Promise<void> {
    await execute(`DELETE FROM t_dsh_mcp_credentials WHERE connector_id = ?`, [connectorId])
  }

  async setToolCount(connectorId: string, count: number): Promise<void> {
    await execute(`UPDATE t_dsh_mcp_connectors SET tool_count = ? WHERE id = ?`, [count, connectorId])
  }
}

export const mcpRepository = new MCPRepository()