import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AuthenticatedPrincipal, MemorySearchInput, PromoteMemoryInput, TenantContext } from '@dsh-platform/shared'
import { memoryService } from '../services/memory-service.js'
import { readMemoryProjectionStatus } from '../memory-projection.js'
import { getRuntime } from '../supervisor.js'
import { resolveRuntimeToken } from '../internal-channel.js'

function toCtx(p: AuthenticatedPrincipal): TenantContext {
  return {
    tenantId: p.tenantId,
    userId: p.userId,
    role: p.role,
    requestId: p.requestId ?? '',
    platformSessionId: p.platformSessionId ?? '',
    deviceId: p.deviceId,
  }
}

interface RuntimeIdentity { userId: string; tenantId: string }

/** 从 runtime token 解析身份(不接受 body/query 身份)。 */
function resolveRuntime(req: FastifyRequest): RuntimeIdentity | null {
  const token = req.headers['x-runtime-token']
  if (typeof token !== 'string') return null
  const identity = resolveRuntimeToken(token)
  return identity === null ? null : { userId: identity.userId, tenantId: identity.tenantId }
}

export function registerMemoryRoutes(app: FastifyInstance): void {
  // --- 公共平台 API(浏览器,principal 认证) ---

  app.get('/api/memory/namespaces', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const ctx = toCtx(req.principal)
    const result = await memoryService.search(ctx, { query: '', limit: 100 })
    const namespaces = new Set(result.records.map((r) => r.namespace))
    namespaces.add('default')
    return { namespaces: [...namespaces] }
  })

  app.get('/api/memory', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const ctx = toCtx(req.principal)
    const query = req.query as Record<string, string | undefined>
    const input: MemorySearchInput = {
      query: query.q ?? '',
      namespace: query.namespace,
      kind: query.kind as MemorySearchInput['kind'],
      visibility: query.visibility as MemorySearchInput['visibility'],
      limit: query.limit ? Number(query.limit) : 20,
      offset: query.offset ? Number(query.offset) : 0,
    }
    return memoryService.search(ctx, input)
  })

  app.get('/api/memory/runtime-status', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const runtime = getRuntime(req.principal.userId)
    const status = await readMemoryProjectionStatus(req.principal.tenantId, req.principal.userId, runtime?.state)
    return { provider: 'cmcc-memory', teamRuntime: false, ...status }
  })

  app.post('/api/memory', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const ctx = toCtx(req.principal)
    const body = req.body as Record<string, unknown> | undefined
    const content = typeof body?.content === 'string' ? body.content.trim() : ''
    if (!content) return reply.code(400).send({ error: 'content-required' })
    try {
      const record = await memoryService.remember(ctx, content, {
        namespace: typeof body?.namespace === 'string' ? body.namespace : undefined,
        kind: typeof body?.kind === 'string' ? (body.kind as MemorySearchInput['kind']) : undefined,
        sourceType: typeof body?.sourceType === 'string' ? body.sourceType : undefined,
        sourceSessionId: typeof body?.sourceSessionId === 'string' ? body.sourceSessionId : undefined,
      })
      await memoryService.buildProjection(ctx.userId, ctx.tenantId)
      return reply.code(201).send(record)
    } catch (err) {
      const msg = (err as Error).message
      if (msg === 'secret-not-allowed') return reply.code(400).send({ error: msg })
      if (msg === 'content-too-long') return reply.code(400).send({ error: msg })
      throw err
    }
  })

  app.get('/api/memory/:id', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const ctx = toCtx(req.principal)
    const params = req.params as { id: string }
    const record = await memoryService.get(ctx, params.id)
    if (!record) return reply.code(404).send({ error: 'not-found' })
    return record
  })

  app.delete('/api/memory/:id', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const ctx = toCtx(req.principal)
    const params = req.params as { id: string }
    const deleted = await memoryService.forget(ctx, params.id)
    if (!deleted) return reply.code(404).send({ error: 'not-found' })
    await memoryService.buildProjection(ctx.userId, ctx.tenantId)
    return { ok: true }
  })

  app.post('/api/memory/:id/promote', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const ctx = toCtx(req.principal)
    const params = req.params as { id: string }
    const body = req.body as Record<string, unknown> | undefined
    const targetVisibility = typeof body?.targetVisibility === 'string' ? body.targetVisibility : ''
    if (!['personal', 'tenant_shared'].includes(targetVisibility)) {
      return reply.code(400).send({ error: 'invalid-visibility' })
    }
    const input: PromoteMemoryInput = {
      memoryId: params.id,
      targetVisibility: targetVisibility as PromoteMemoryInput['targetVisibility'],
      reason: typeof body?.reason === 'string' ? body.reason : undefined,
    }
    const result = await memoryService.promote(ctx, input)
    if (!result.ok) return reply.code(400).send({ error: result.reason ?? 'promote-failed' })
    await memoryService.buildProjection(ctx.userId, ctx.tenantId)
    return { ok: true }
  })

  // --- Internal mutation channel(runtime token 认证;不暴露给浏览器) ---

  app.post('/internal/memory/remember', async (req, reply) => {
    const identity = resolveRuntime(req)
    if (identity === null) return reply.code(401).send({ error: 'invalid-runtime-token' })
    const body = req.body as Record<string, unknown> | undefined
    const content = typeof body?.content === 'string' ? body.content.trim() : ''
    if (!content) return reply.code(400).send({ error: 'content-required' })
    try {
      const record = await memoryService.runtimeRemember(identity.userId, identity.tenantId, content, {
        kind: typeof body?.kind === 'string' ? (body.kind as MemorySearchInput['kind']) : undefined,
        namespace: typeof body?.namespace === 'string' ? body.namespace : undefined,
        sourceSessionId: typeof body?.sourceSessionId === 'string' ? body.sourceSessionId : undefined,
        sourceEventSeq: typeof body?.sourceEventSeq === 'number' ? body.sourceEventSeq : undefined,
        extractionMode: typeof body?.extractionMode === 'string' ? body.extractionMode : undefined,
      })
      await memoryService.buildProjection(identity.userId, identity.tenantId)
      return reply.code(201).send({ id: record.id, kind: record.kind, scope: record.visibility })
    } catch (err) {
      const msg = (err as Error).message
      if (msg === 'secret-not-allowed') return reply.code(400).send({ error: msg })
      if (msg === 'content-too-long') return reply.code(400).send({ error: msg })
      throw err
    }
  })

  app.delete('/internal/memory/:id', async (req, reply) => {
    const identity = resolveRuntime(req)
    if (identity === null) return reply.code(401).send({ error: 'invalid-runtime-token' })
    const params = req.params as { id: string }
    const deleted = await memoryService.runtimeForget(identity.userId, identity.tenantId, params.id)
    if (!deleted) return reply.code(404).send({ error: 'not-found' })
    await memoryService.buildProjection(identity.userId, identity.tenantId)
    return { ok: true }
  })

  /** 自动提取写回:仅 completed turn 调用;服务端再做 secret/敏感过滤 + 幂等。 */
  app.post('/internal/memory/extract', async (req, reply) => {
    const identity = resolveRuntime(req)
    if (identity === null) return reply.code(401).send({ error: 'invalid-runtime-token' })
    const body = req.body as Record<string, unknown> | undefined
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    const turn = typeof body?.turn === 'number' ? body.turn : -1
    const rawMemories = Array.isArray(body?.memories) ? body.memories : []
    if (sessionId === '' || turn < 0) return reply.code(400).send({ error: 'session-and-turn-required' })
    const memories = rawMemories
      .filter((m): m is { content: string; kind: string } => typeof m === 'object' && m !== null && typeof (m as Record<string, unknown>).content === 'string')
      .map((m) => ({ content: m.content, kind: (m.kind as MemorySearchInput['kind']) ?? 'other' }))
    const count = await memoryService.extractAndPersist(identity.userId, identity.tenantId, sessionId, turn, memories)
    return { ok: true, extracted: count }
  })
}