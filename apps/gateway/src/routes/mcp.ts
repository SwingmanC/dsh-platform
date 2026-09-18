import type { FastifyInstance } from 'fastify'
import type { AuthenticatedPrincipal, TenantContext } from '@dsh-platform/shared'
import { mcpService } from '../services/mcp-service.js'
import { readMcpProjectionStatus, readMcpProjection, readMcpAck } from '../mcp-projection.js'
import { getRuntime } from '../supervisor.js'

function toCtx(p: AuthenticatedPrincipal): TenantContext {
  return { tenantId: p.tenantId, userId: p.userId, role: p.role, requestId: '', platformSessionId: '', deviceId: p.deviceId }
}

async function rebuildOwn(p: AuthenticatedPrincipal): Promise<void> {
  try { await mcpService.buildProjection(p.userId, p.tenantId) } catch (err) {
    process.stderr.write(`[mcp-projection] rebuild failed for ${p.userId}: ${String(err)}\n`)
  }
}

export function registerMCPRoutes(app: FastifyInstance): void {
  app.get('/api/connectors', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    return { connectors: await mcpService.list(toCtx(req.principal)) }
  })

  app.post('/api/connectors', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const body = req.body as Record<string, unknown> | undefined
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    const serverName = typeof body?.serverName === 'string' ? body.serverName.trim() : ''
    const transport = typeof body?.transport === 'string' ? body.transport : ''
    if (!name || !serverName || !transport) return reply.code(400).send({ error: 'name-serverName-transport-required' })
    try {
      const connector = await mcpService.create(toCtx(req.principal), {
        name, serverName, transport,
        command: typeof body?.command === 'string' ? body.command : undefined,
        endpointUrl: typeof body?.endpointUrl === 'string' ? body.endpointUrl : undefined,
        authType: typeof body?.authType === 'string' ? body.authType : undefined,
        scope: typeof body?.scope === 'string' ? body.scope : 'user',
        riskLevel: typeof body?.riskLevel === 'string' ? body.riskLevel : 'low',
        visibility: typeof body?.visibility === 'string' ? body.visibility : 'private',
      })
      return reply.code(201).send(connector)
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  /** 服务端审批边界:仅管理员(非管理员 403)。 */
  app.post('/api/connectors/:id/approve', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const { id } = req.params as { id: string }
    try {
      const ok = await mcpService.approve(toCtx(req.principal), id)
      if (!ok) return reply.code(404).send({ error: 'not-found' })
      return { ok: true }
    } catch (err) {
      const msg = (err as Error).message
      if (msg === 'forbidden') return reply.code(403).send({ error: 'forbidden' })
      if (msg === 'not-found') return reply.code(404).send({ error: 'not-found' })
      return reply.code(400).send({ error: msg })
    }
  })

  app.post('/api/connectors/:id/disable', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const { id } = req.params as { id: string }
    try {
      const ok = await mcpService.disable(toCtx(req.principal), id)
      if (!ok) return reply.code(404).send({ error: 'not-found' })
      return { ok: true }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.post('/api/connectors/:id/authorize', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const { id } = req.params as { id: string }
    try {
      await mcpService.authorize(toCtx(req.principal), id)
      await rebuildOwn(req.principal)
      return { ok: true }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  /** revoke:deny-first(移除授权 + 立即重建投影;credential 不再注入)。 */
  app.delete('/api/connectors/:id/authorize', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const { id } = req.params as { id: string }
    await mcpService.revoke(toCtx(req.principal), id)
    await rebuildOwn(req.principal)
    return { ok: true }
  })

  /** 保存/轮换 credential:服务端加密;永不返回明文。 */
  app.put('/api/connectors/:id/credential', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const { id } = req.params as { id: string }
    const body = req.body as Record<string, unknown> | undefined
    const secret = typeof body?.secret === 'string' ? body.secret : ''
    try {
      await mcpService.saveCredential(toCtx(req.principal), id, secret)
      await rebuildOwn(req.principal)
      return { ok: true, configured: true }
    } catch (err) {
      const msg = (err as Error).message
      if (msg === 'not-found') return reply.code(404).send({ error: 'not-found' })
      if (msg === 'empty-secret') return reply.code(400).send({ error: 'empty-secret' })
      return reply.code(400).send({ error: msg })
    }
  })

  app.get('/api/connectors/authorized', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    return { connectors: await mcpService.listAuthorized(toCtx(req.principal)) }
  })

  /** MCP Runtime 投影状态(真实 evidence:desired/observed + Runtime 进程状态)。 */
  app.get('/api/connectors/runtime-status', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const runtime = getRuntime(req.principal.userId)
    const status = await readMcpProjectionStatus(req.principal.tenantId, req.principal.userId, runtime?.state)
    const projection = await readMcpProjection(req.principal.tenantId, req.principal.userId)
    const ack = await readMcpAck(req.principal.tenantId, req.principal.userId)
    const observedServers = ack?.servers?.map((s) => s.serverName) ?? []
    const desiredServers = projection?.servers.map((s) => s.serverName) ?? []
    return {
      provider: 'cmcc-mcp',
      ...status,
      desiredServers,
      observedServers,
      observedToolCount: ack?.toolCount ?? 0,
      excluded: projection?.excluded ?? [],
      applyMode: 'CONTROLLED_RUNTIME_RESTART',
    }
  })
}