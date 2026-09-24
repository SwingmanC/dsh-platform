import type { FastifyInstance } from 'fastify'
import { resolveRuntimeToken } from '../internal-channel.js'
import { usageRepository } from '../repositories/usage-repository.js'

const SAFE_NAME = /^[A-Za-z0-9._:@/-]{1,128}$/
const MAX_TOKENS = 10_000_000_000
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKENS ? value : null
}

export function registerUsageRoutes(app: FastifyInstance): void {
  app.post('/internal/usage/events', async (req, reply) => {
    const rawToken = req.headers['x-runtime-token']
    const token = Array.isArray(rawToken) ? rawToken[0] : rawToken
    const identity = resolveRuntimeToken(typeof token === 'string' ? token : '')
    if (identity === null) return reply.code(401).send({ error: 'invalid-runtime-token' })
    const body = req.body as Record<string, unknown> | undefined
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    const eventSeq = count(body?.eventSeq)
    const provider = typeof body?.provider === 'string' && SAFE_NAME.test(body.provider) ? body.provider : 'unknown'
    const model = typeof body?.model === 'string' && SAFE_NAME.test(body.model) ? body.model : 'unknown'
    const eventType = body?.eventType === undefined ? 'message' : body.eventType
    const rawTurn = body?.turn
    const rawStep = body?.step
    const turn = rawTurn === undefined || rawTurn === null ? null : count(rawTurn)
    const step = rawStep === undefined || rawStep === null ? null : count(rawStep)
    const usageKnown = body?.usageKnown === undefined ? true : body.usageKnown
    const fields = [body?.inputTokens, body?.outputTokens, body?.cacheReadTokens, body?.cacheWriteTokens, body?.reasoningTokens].map(count)
    const occurredAt = typeof body?.occurredAt === 'string' ? new Date(body.occurredAt) : new Date(NaN)
    if (sessionId === '' || sessionId.length > 128 || eventSeq === null || fields.some((v) => v === null) || Number.isNaN(occurredAt.valueOf())
      || (eventType !== 'message' && eventType !== 'attempt') || (rawTurn != null && turn === null)
      || (rawStep != null && step === null) || typeof usageKnown !== 'boolean') {
      return reply.code(400).send({ error: 'invalid-usage-event' })
    }
    const inputTokens = fields[0] as number
    const outputTokens = fields[1] as number
    const cacheReadTokens = fields[2] as number
    const cacheWriteTokens = fields[3] as number
    const reasoningTokens = fields[4] as number
    const eventKey = `${identity.userId}:${sessionId}:${eventSeq}`
    const inserted = await usageRepository.record({ eventKey, ...identity, sessionId, eventSeq, provider, model,
      eventType, turn, step, usageKnown,
      inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, occurredAt })
    return reply.code(inserted ? 201 : 200).send({ ok: true, duplicate: !inserted })
  })

  app.get('/api/usage/summary', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    if (req.principal.role !== 'tenant_admin') return reply.code(404).send({ error: 'not-found' })
    const raw = Number((req.query as { days?: string }).days ?? 30)
    const days = raw === 7 || raw === 30 || raw === 90 ? raw : 30
    try {
      return await usageRepository.summary(req.principal.tenantId, days)
    } catch (err) {
      req.log.error({ err }, 'usage summary failed')
      return reply.code(500).send({ error: 'usage-summary-failed' })
    }
  })
}
