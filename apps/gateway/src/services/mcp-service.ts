import type { TenantContext, MCPConnector, MCPTransport, MCPScope, MCPRiskLevel } from '@dsh-platform/shared'
import { mcpRepository } from '../repositories/mcp-repository.js'
import { getCredentialStore } from '../credentials/credential-store.js'
import { buildMcpProjection, validateMcpUrl, SERVER_NAME_RE } from '../mcp-projection.js'
import { probeMcpServer, redactSecrets, McpTestError } from '../mcp-test.js'
import type { McpProbeResult } from '../mcp-test.js'
import { config } from '../config.js'

const ADMIN_ROLES: ReadonlySet<string> = new Set(['tenant_admin', 'operator'])

/** 连接测试结果(启用前探针;与审批/授权/投影无副作用关联)。 */
export type McpTestOutcome = McpProbeResult & { authConfigured: boolean }

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

  /**
   * 连接测试(任务 02):正式启用(approve/authorize)前的一次性探针。
   *
   * - 与持久化/审批/授权/投影分离:不写 approved/authorization,不触发投影重建;
   *   仅回写 `last_test_at` 与成功时的 `tool_count`(信息性字段)。
   * - 权限边界:复用 `findById` 的可见性范围(creator / 同租户 / platform),
   *   与列表接口一致——能看到的连接器即可测试(测试本身只读 initialize+tools/list)。
   * - stdio 不支持网关侧测试:进程拉起只归 Runtime 内官方 dsh-mcp-client。
   * - 鉴权:authType 需要凭据且已配置时,解密注入 Authorization;错误消息脱敏。
   */
  async testConnection(ctx: TenantContext, connectorId: string): Promise<McpTestOutcome> {
    const connector = await mcpRepository.findById(ctx, connectorId)
    if (!connector) throw new Error('not-found')
    if (connector.transport === 'stdio') throw new Error('stdio-test-unsupported')
    if (connector.transport !== 'streamable-http') throw new Error('unsupported-transport')
    const v = validateMcpUrl(connector.endpointUrl ?? '')
    if (!v.ok) throw new Error(`url-rejected:${v.reason}`)

    const headers: Record<string, string> = {}
    let authConfigured = false
    let secret: string | null = null
    const needsCredential = connector.authType !== null && connector.authType !== '' && connector.authType !== 'none'
    let envelope: string | null = null
    if (needsCredential) {
      envelope = await mcpRepository.getCredentialEnvelope(connector.id)
      if (envelope !== null) {
        secret = getCredentialStore().open(envelope)
        // CRLF/控制字符显式防护:含控制字符的 secret 禁止进入 header(结构化失败,不靠底层库兜底)。
        // eslint-disable-next-line no-control-regex
        if (/[\u0000-\u001f\u007f]/.test(secret)) throw new Error('credential-control-characters')
        headers.authorization = `Bearer ${secret}`
        authConfigured = true
      }
    }

    let probe: McpProbeResult
    try {
      probe = await probeMcpServer({ url: v.url, headers, timeoutMs: config.mcp.testTimeoutMs })
    } catch (err) {
      if (err instanceof McpTestError) {
        // 目录安全边界(数量/schema 超限):结构化失败,保留既有快照(§6)。
        await mcpRepository.touchLastTest(connector.id)
        return { ok: false, code: err.code, message: err.code, durationMs: 0, authConfigured }
      }
      throw err
    }
    await mcpRepository.touchLastTest(connector.id)
    if (probe.ok) {
      await mcpRepository.setToolCount(connector.id, probe.toolCount)
      // MCP-V1.1:成功 discovery → replace 快照(§7);失败路径不触碰(§6 保留上次成功目录)。
      await mcpRepository.setToolsSnapshot(connector.id, probe.tools)
      return { ...probe, authConfigured }
    }
    // 纵深脱敏:探针内已按 header 值过滤,这里再过滤 secret 明文与加密 envelope。
    const message = redactSecrets(probe.message, [secret, envelope])
    return { ok: false, code: probe.code, message, durationMs: probe.durationMs, authConfigured }
  }
}

export const mcpService = new MCPService()