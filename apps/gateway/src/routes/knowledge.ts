import type { FastifyInstance } from 'fastify'
import type { AuthenticatedPrincipal, TenantContext, KbSearchInput } from '@dsh-platform/shared'
import { knowledgeService } from '../services/knowledge-service.js'
import { readKnowledgeProjectionStatus } from '../knowledge-projection.js'
import { getRuntime } from '../supervisor.js'

function toCtx(p: AuthenticatedPrincipal): TenantContext {
  return { tenantId: p.tenantId, userId: p.userId, role: p.role, requestId: '', platformSessionId: '', deviceId: p.deviceId }
}

async function rebuildProjection(p: AuthenticatedPrincipal): Promise<void> {
  try { await knowledgeService.buildProjection(p.userId, p.tenantId) } catch (err) {
    process.stderr.write(`[knowledge-projection] rebuild failed for ${p.userId}: ${String(err)}\n`)
  }
}

export function registerKnowledgeRoutes(app: FastifyInstance): void {
  app.get('/api/knowledge-bases', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    return { knowledgeBases: await knowledgeService.listBases(toCtx(req.principal)) }
  })

  app.post('/api/knowledge-bases', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const body = req.body as Record<string, unknown> | undefined
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!name) return reply.code(400).send({ error: 'name-required' })
    const kb = await knowledgeService.createBase(toCtx(req.principal), {
      name, description: typeof body?.description === 'string' ? body.description : undefined,
      visibility: typeof body?.visibility === 'string' ? body.visibility : 'personal',
      category: typeof body?.category === 'string' ? body.category : undefined,
    })
    return reply.code(201).send(kb)
  })

  app.get('/api/knowledge-bases/:id/documents', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const { id } = req.params as { id: string }
    return { documents: await knowledgeService.listDocuments(toCtx(req.principal), id) }
  })

  app.post('/api/knowledge-bases/:id/documents', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const { id: kbId } = req.params as { id: string }
    const body = req.body as Record<string, unknown> | undefined
    const filename = typeof body?.filename === 'string' ? body.filename.trim() : ''
    const content = typeof body?.content === 'string' ? body.content : ''
    if (!filename || !content) return reply.code(400).send({ error: 'filename-and-content-required' })
    const buffer = Buffer.from(content, 'utf8')
    const ext = filename.split('.').pop()?.toLowerCase() ?? ''
    const mime = ext === 'md' ? 'text/markdown' : 'text/plain'
    try {
      const doc = await knowledgeService.uploadDocument(toCtx(req.principal), kbId, filename, mime, buffer)
      await rebuildProjection(req.principal)
      return reply.code(201).send(doc)
    } catch (err) {
      const msg = (err as Error).message
      if (msg === 'knowledge-base-not-found') return reply.code(404).send({ error: msg })
      if (msg.startsWith('unsupported-mime')) return reply.code(400).send({ error: msg })
      if (msg === 'document-too-large') return reply.code(413).send({ error: msg })
      throw err
    }
  })

  app.get('/api/knowledge/runtime-status', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const runtime = getRuntime(req.principal.userId)
    const status = await readKnowledgeProjectionStatus(req.principal.tenantId, req.principal.userId, runtime?.state)
    return { provider: 'cmcc-knowledge', ...status }
  })

  app.get('/api/knowledge/search', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const q = req.query as Record<string, string | undefined>
    const input: KbSearchInput = {
      q: q.q ?? '', kbId: q.kbId,
      limit: q.limit ? Number(q.limit) : 10, offset: q.offset ? Number(q.offset) : 0,
    }
    if (!input.q) return { chunks: [], total: 0 }
    return knowledgeService.search(toCtx(req.principal), input)
  })

  app.post('/api/knowledge-bases/:id/mount', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const { id } = req.params as { id: string }
    await knowledgeService.mount(toCtx(req.principal), id)
    await rebuildProjection(req.principal)
    return { ok: true }
  })

  app.delete('/api/knowledge-bases/:id/mount', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const { id } = req.params as { id: string }
    await knowledgeService.unmount(toCtx(req.principal), id)
    await rebuildProjection(req.principal)
    return { ok: true }
  })

  app.get('/api/knowledge/mounts', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    return { mounts: await knowledgeService.listMounts(toCtx(req.principal)) }
  })
}