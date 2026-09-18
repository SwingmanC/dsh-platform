import type { TenantContext, MCPConnector, MCPTransport, MCPScope, MCPRiskLevel } from '@dsh-platform/shared'
import { mcpRepository } from '../repositories/mcp-repository.js'
import { getCredentialStore } from '../credentials/credential-store.js'
import { buildMcpProjection, validateMcpUrl, SERVER_NAME_RE } from '../mcp-projection.js'
import { config } from '../config.js'

const ADMIN_ROLES: ReadonlySet<string> = new Set(['tenant_admin', 'operator'])

export class MCPService {
  async list(ctx: TenantContext): Promise<MCPConnector[]> {
    return mcpRepository.list(ctx)
  }

  async create(ctx: TenantContext, data: {
    name: string; serverName: string; transport: string; scope?: string; riskLevel?: string;
    command?: string; endpointUrl?: string; authType?: string; visibility?: string
  }): Promise<MCPConnector> {
    if (!SERVER_NAME_RE.test(data.serverName)) throw new Error('invalid-server-name')
    if (data.transport === 'stdio') {
      // 普通用户不得提交任意 command;stdio 进入 Runtime 需管理员模板治理。
      if (!config.mcp.allowStdio) throw new Error('stdio-disabled-by-policy')
      if (!data.command) throw new Error('stdio-command-required')
    }
    if (data.transport === 'streamable-http') {
      if (!data.endpointUrl) throw new Error('http-url-required')
      const v = validateMcpUrl(data.endpointUrl)
      if (!v.ok) throw new Error(`url-rejected:${v.reason}`)
    }
    return mcpRepository.create(ctx, {
      ...data, transport: data.transport as MCPTransport,
      scope: data.scope as MCPScope, riskLevel: data.riskLevel as MCPRiskLevel,
    })
  }

  /** 服务端审批边界:仅管理员。非管理员一律拒绝(不能靠前端隐藏按钮)。 */
  async approve(ctx: TenantContext, id: string): Promise<boolean> {
    if (!ADMIN_ROLES.has(ctx.role)) throw new Error('forbidden')
    const row = await mcpRepository.findRawById(id)
    if (!row) throw new Error('not-found')
    if (row.transport === 'streamable-http') {
      const v = validateMcpUrl(row.endpointUrl ?? '')
      if (!v.ok) throw new Error(`url-rejected:${v.reason}`)
    }
    const ok = await mcpRepository.approve(id, ctx.userId)
    if (ok) await this.rebuildProjectionsForConnector(id)
    return ok
  }

  async disable(ctx: TenantContext, id: string): Promise<boolean> {
    const owned = await mcpRepository.findOwned(ctx, id)
    if (!owned) throw new Error('not-found')
    const ok = await mcpRepository.disable(ctx, id)
    if (ok) await this.rebuildProjectionsForConnector(id)
    return ok
  }

  async authorize(ctx: TenantContext, connectorId: string): Promise<boolean> {
    const connector = await mcpRepository.findById(ctx, connectorId)
    if (!connector) throw new Error('not-found')
    if (!connector.approved) throw new Error('not-approved')
    if (connector.status !== 'active') throw new Error('connector-inactive')
    if (connector.transport === 'stdio' && !config.mcp.allowStdio) throw new Error('stdio-disabled-by-policy')
    if (connector.transport === 'streamable-http') {
      const v = validateMcpUrl(connector.endpointUrl ?? '')
      if (!v.ok) throw new Error(`url-rejected:${v.reason}`)
    }
    await this.assertNoServerNameCollision(ctx, connectorId, connector.serverName)
    return mcpRepository.authorize(ctx, connectorId)
  }

  async revoke(ctx: TenantContext, connectorId: string): Promise<boolean> {
    return mcpRepository.revoke(ctx, connectorId)
  }

  async listAuthorized(ctx: TenantContext): Promise<MCPConnector[]> {
    const ids = new Set(await mcpRepository.listAuthorizedIds(ctx.userId))
    const all = await mcpRepository.list(ctx)
    return all.filter((c) => ids.has(c.id))
  }

  /** 保存/轮换 credential(浏览器 TLS 提交;服务端加密;永不返回明文)。 */
  async saveCredential(ctx: TenantContext, connectorId: string, secret: string): Promise<void> {
    const connector = await mcpRepository.findById(ctx, connectorId)
    if (!connector) throw new Error('not-found')
    if (secret.trim() === '') throw new Error('empty-secret')
    const envelope = getCredentialStore().seal(secret)
    await mcpRepository.putCredential(ctx.tenantId, connectorId, envelope)
    await this.rebuildProjectionsForConnector(connectorId)
  }

  async buildProjection(userId: string, tenantId: string): Promise<void> {
    await buildMcpProjection(tenantId, userId)
  }

  /** approve/disable/credential 变更后刷新所有已授权用户投影。 */
  async rebuildProjectionsForConnector(connectorId: string): Promise<number> {
    const owners = await mcpRepository.listAuthorizedUserIds(connectorId)
    let count = 0
    for (const owner of owners) {
      await buildMcpProjection(owner.tenantId, owner.userId)
      count += 1
    }
    return count
  }

  /** 同一 Runtime scope 内 serverName 必须唯一(否则 DSH 启动时报错)。 */
  private async assertNoServerNameCollision(ctx: TenantContext, connectorId: string, serverName: string): Promise<void> {
    const projectable = await mcpRepository.listProjectableAuthorized(ctx.userId, ctx.tenantId)
    const clash = projectable.find((c) => c.id !== connectorId && c.serverName === serverName)
    if (clash) throw new Error('server-name-collision')
  }
}

export const mcpService = new MCPService()