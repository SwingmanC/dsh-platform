import type { FastifyInstance } from 'fastify'
import type { AuthenticatedPrincipal, TenantContext, KbSearchInput } from '@dsh-platform/shared'
import multipart from '@fastify/multipart'
import { knowledgeService } from '../services/knowledge-service.js'
import { readKnowledgeProjectionStatus } from '../knowledge-projection.js'
import { getRuntime } from '../supervisor.js'
import { resolveRuntimeToken } from '../internal-channel.js'
import { KNOWLEDGE_MAX_TEXT_BYTES } from '../ingestion.js'

function toCtx(p: AuthenticatedPrincipal): TenantContext {
  return { tenantId: p.tenantId, userId: p.userId, role: p.role, requestId: '', platformSessionId: '', deviceId: p.deviceId }
}

/** K-T1 multipart 允许集:扩展名 → 规范 MIME。 */
const FILE_EXT_MIME: Record<string, string> = {
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}
const GENERIC_MIME = new Set(['', 'application/octet-stream', 'application/x-download'])

async function rebuildProjection(p: AuthenticatedPrincipal): Promise<void> {
  try { await knowledgeService.buildProjection(p.userId, p.tenantId) } catch (err) {
    process.stderr.write(`[knowledge-projection] rebuild failed for ${p.userId}: ${String(err)}\n`)
  }
}

export function registerKnowledgeRoutes(app: FastifyInstance): void {
  // K-T1:multipart 上传(仅 /files 路由使用;大小限制在读取时强制生效)。
  void app.register(multipart, { limits: { fileSize: KNOWLEDGE_MAX_TEXT_BYTES, files: 1 } })

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

  /** K-T1:PDF/DOCX(及 txt/md)multipart 上传;复用 findBase 授权 / storeUploadedDocument / chunkDocument / jobs。 */
  app.post('/api/knowledge-bases/:id/files', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const { id: kbId } = req.params as { id: string }

    let data: Awaited<ReturnType<typeof req.file>>
    try {
      data = await req.file({ limits: { fileSize: KNOWLEDGE_MAX_TEXT_BYTES, files: 1 } })
    } catch {
      return reply.code(400).send({ error: 'multipart-required' })
    }
    if (data === undefined) return reply.code(400).send({ error: 'multipart-file-required' })

    const filename = (data.filename || '').trim()
    const declaredMime = (data.mimetype || '').toLowerCase()
    const ext = filename.split('.').pop()?.toLowerCase() ?? ''
    const canonicalMime = FILE_EXT_MIME[ext]
    if (canonicalMime === undefined) return reply.code(400).send({ error: `unsupported-extension: ${ext.slice(0, 16)}` })
    // MIME 与扩展名双重校验:通用二进制 MIME 视为未知放行;明显不一致拒绝。
    if (declaredMime !== '' && !GENERIC_MIME.has(declaredMime) && declaredMime !== canonicalMime) {
      return reply.code(400).send({ error: 'mime-extension-mismatch' })
    }

    let buffer: Buffer
    try {
      buffer = await data.toBuffer()
    } catch (err) {
      const code = (err as { code?: string }).code ?? ''
      if (code === 'FST_PART_FILE_TOO_LARGE') return reply.code(413).send({ error: 'file-too-large' })
      return reply.code(400).send({ error: 'file-read-failed' })
    }

    try {
      const doc = await knowledgeService.uploadDocument(toCtx(req.principal), kbId, filename, canonicalMime, buffer)
      await rebuildProjection(req.principal)
      return reply.code(201).send(doc)
    } catch (err) {
      const msg = (err as Error).message
      if (msg === 'knowledge-base-not-found') return reply.code(404).send({ error: msg })
      if (msg.startsWith('unsupported-mime') || msg.startsWith('unsupported-extension')) return reply.code(400).send({ error: msg })
      if (msg === 'document-too-large' || msg === 'file-too-large') return reply.code(413).send({ error: 'file-too-large' })
      if (msg === 'pdf-no-extractable-text' || msg === 'docx-no-extractable-text' ||
          msg === 'pdf-parse-failed' || msg === 'docx-parse-failed') {
        // 结构化解析失败:文档已标记 failed,错误码可控。
        return reply.code(422).send({ error: msg })
      }
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
    const input: KbSearchInput & { mode?: string } = {
      q: q.q ?? '', kbId: q.kbId,
      limit: q.limit ? Number(q.limit) : 10, offset: q.offset ? Number(q.offset) : 0,
      mode: q.mode === 'keyword' ? 'keyword' : undefined, // K-T6-lite:默认 hybrid(自动降级 keyword)
    }
    if (!input.q) return { chunks: [], total: 0, retrievalMode: 'keyword' }
    return knowledgeService.search(toCtx(req.principal), input)
  })

  // --- K-T3:Embedding Provider 配置(租户级;仅管理员;CSRF 由全局守卫) ---

  app.get('/api/knowledge/embedding-config', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    try {
      const view = await knowledgeService.getEmbeddingConfig(toCtx(req.principal))
      if (view === null) return reply.code(404).send({ error: 'embedding-config-not-found' })
      return view
    } catch (err) {
      if ((err as Error).message === 'forbidden') return reply.code(403).send({ error: 'forbidden' })
      throw err
    }
  })

  app.put('/api/knowledge/embedding-config', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const body = req.body as Record<string, unknown> | undefined
    const provider = typeof body?.provider === 'string' ? body.provider.trim() : 'openai-compatible'
    const baseUrl = typeof body?.baseUrl === 'string' ? body.baseUrl.trim() : ''
    const model = typeof body?.model === 'string' ? body.model.trim() : ''
    const dims = typeof body?.dims === 'number' ? body.dims : Number.NaN
    const apiKey = typeof body?.apiKey === 'string' ? body.apiKey : ''
    try {
      const view = await knowledgeService.saveEmbeddingConfig(toCtx(req.principal), { provider, baseUrl, model, dims, apiKey })
      return view
    } catch (err) {
      const msg = (err as Error).message
      if (msg === 'forbidden') return reply.code(403).send({ error: 'forbidden' })
      if (msg === 'empty-api-key' || msg === 'invalid-config' || msg.startsWith('embedding-config-invalid:') || msg.startsWith('unsupported-provider')) {
        return reply.code(400).send({ error: msg })
      }
      if (msg === 'missing-encryption-key' || msg === 'invalid-encryption-key') return reply.code(400).send({ error: msg })
      throw err
    }
  })

  app.post('/api/knowledge/embedding-config/test', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    try {
      return await knowledgeService.testEmbeddingConfig(toCtx(req.principal))
    } catch (err) {
      const msg = (err as Error).message
      if (msg === 'forbidden') return reply.code(403).send({ error: 'forbidden' })
      if (msg === 'embedding-config-not-found') return reply.code(404).send({ error: msg })
      if (msg === 'decrypt-failed' || msg === 'missing-encryption-key') return reply.code(400).send({ error: msg })
      throw err
    }
  })

  /** K-T6-FINAL:Runtime knowledge_search seam(runtime token 认证;复用 KnowledgeService 混合检索)。 */
  app.post('/internal/knowledge/search', async (req, reply) => {
    const token = req.headers['x-runtime-token']
    const identity = typeof token === 'string' ? resolveRuntimeToken(token) : null
    if (identity === null) return reply.code(401).send({ error: 'invalid-runtime-token' })
    const body = req.body as Record<string, unknown> | undefined
    const query = typeof body?.query === 'string' ? body.query : ''
    if (query.trim() === '') return { results: [], retrievalMode: 'keyword' }
    const knowledgeBase = typeof body?.knowledgeBase === 'string' && body.knowledgeBase !== '' ? body.knowledgeBase : undefined
    const limit = typeof body?.limit === 'number' ? Math.min(Math.max(Math.floor(body.limit), 1), 20) : 5
    try {
      return await knowledgeService.searchForRuntime(
        { userId: identity.userId, tenantId: identity.tenantId },
        { query, knowledgeBase, limit },
      )
    } catch {
      return reply.code(500).send({ error: 'search-failed' })
    }
  })

  /** K-T7:citation resolve —— 硬性 ACL 重校验;任何环节不满足 → 404,不泄露元数据。 */
  app.get('/api/knowledge/citations/resolve', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const q = req.query as Record<string, string | undefined>
    const citationId = typeof q.citation === 'string' ? q.citation : ''
    try {
      const resolved = await knowledgeService.resolveCitation(toCtx(req.principal), citationId)
      if (resolved === null) return reply.code(404).send({ error: 'citation-not-found' })
      return resolved
    } catch (err) {
      if ((err as Error).message === 'invalid-citation-id') return reply.code(400).send({ error: 'invalid-citation-id' })
      throw err
    }
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