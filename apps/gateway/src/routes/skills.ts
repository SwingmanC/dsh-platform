import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AuthenticatedPrincipal, TenantContext, SkillSearchInput } from '@dsh-platform/shared'
import { skillService, SKILL_IMPORT_EXTENSIONS } from '../services/skill-service.js'
import { SKILL_MD_MAX_CHARS } from '../skill-format.js'
import { buildSkillProjection, readSkillProjectionStatus, rebuildProjectionsForSkill } from '../skill-projection.js'
import { getRuntime } from '../supervisor.js'

function toCtx(p: AuthenticatedPrincipal): TenantContext {
  return { tenantId: p.tenantId, userId: p.userId, role: p.role, requestId: '', platformSessionId: '', deviceId: p.deviceId }
}

/** 重建 principal 自己的投影(失败不阻断业务 mutation)。 */
async function rebuildOwn(p: AuthenticatedPrincipal): Promise<void> {
  try {
    await buildSkillProjection(p.tenantId, p.userId)
  } catch (err) {
    process.stderr.write(`[skill-projection] rebuild failed for ${p.userId}: ${String(err)}\n`)
  }
}

/**
 * SKILL-V1.3:读取 multipart 上传的 SKILL.md(复用 knowledge.ts 已注册的
 * @fastify/multipart — 同一 app 作用域,不新建第二套 multipart parser)。
 * 返回 { filename, text } 或受控错误码。
 */
interface MultipartFilePart {
  filename: string
  toBuffer: () => Promise<Buffer>
}

async function readImportUpload(req: FastifyRequest): Promise<{ filename: string; text: string } | { error: string; statusCode: number }> {
  const file = (req as unknown as { file?: (opts?: Record<string, unknown>) => Promise<MultipartFilePart | undefined> }).file
  if (file === undefined) return { error: 'multipart-unavailable', statusCode: 500 }
  let data: MultipartFilePart | undefined
  try {
    data = await file.call(req, { limits: { fileSize: SKILL_MD_MAX_CHARS, files: 1 } })
  } catch (err) {
    const code = (err as { code?: string }).code ?? ''
    if (code === 'FST_PART_FILE_TOO_LARGE') return { error: 'skill-file-too-large', statusCode: 413 }
    return { error: 'multipart-required', statusCode: 400 }
  }
  if (data === undefined) return { error: 'multipart-file-required', statusCode: 400 }
  const filename = (data.filename || '').trim()
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (!SKILL_IMPORT_EXTENSIONS.has(ext)) return { error: 'invalid-skill-file', statusCode: 400 }
  let buffer: Buffer
  try {
    buffer = await data.toBuffer()
  } catch (err) {
    const code = (err as { code?: string }).code ?? ''
    if (code === 'FST_PART_FILE_TOO_LARGE') return { error: 'skill-file-too-large', statusCode: 413 }
    return { error: 'file-read-failed', statusCode: 400 }
  }
  return { filename, text: buffer.toString('utf8') }
}

/** Import 错误码 → HTTP(§22:区分展示,不做统一 'Import failed')。 */
function sendImportError(reply: FastifyReply, code: string): unknown {
  if (code === 'skill-file-too-large') return reply.code(413).send({ error: code })
  if (code === 'duplicate-skill-name') return reply.code(409).send({ error: code })
  if (['missing-name', 'missing-description', 'missing-body', 'invalid-name', 'invalid-skill-file',
    'malformed-frontmatter', 'name-too-large', 'description-too-large', 'when-to-use-too-large',
    'legacy-frontmatter-key'].some((c) => code.startsWith(c))) {
    return reply.code(400).send({ error: code })
  }
  return reply.code(422).send({ error: code })
}

export function registerSkillRoutes(app: FastifyInstance): void {
  app.get('/api/skills', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const q = req.query as Record<string, string | undefined>
    const input: SkillSearchInput = {
      q: q.q, visibility: q.visibility as SkillSearchInput['visibility'],
      category: q.category, status: q.status as SkillSearchInput['status'],
      limit: q.limit ? Number(q.limit) : 20, offset: q.offset ? Number(q.offset) : 0,
    }
    return skillService.search(toCtx(req.principal), input)
  })

  app.get('/api/skills/installed', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const skills = await skillService.listInstalled(toCtx(req.principal))
    return { skills }
  })

  /**
   * Skill Runtime 投影状态(真实 evidence):desired/observed revision + Runtime 进程状态。
   * 不根据「文件存在」判断 CONNECTED。
   */
  app.get('/api/skills/runtime-status', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const runtime = getRuntime(req.principal.userId)
    const status = await readSkillProjectionStatus(req.principal.tenantId, req.principal.userId, runtime?.state)
    return { provider: 'cmcc-platform', ...status }
  })

  app.get('/api/skills/:id', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const { id } = req.params as { id: string }
    const skill = await skillService.get(toCtx(req.principal), id)
    if (!skill) return reply.code(404).send({ error: 'not-found' })
    return skill
  })

  app.post('/api/skills', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const body = req.body as Record<string, unknown> | undefined
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!name) return reply.code(400).send({ error: 'name-required' })
    const skill = await skillService.create(toCtx(req.principal), {
      name, description: typeof body?.description === 'string' ? body.description : undefined,
      prompt: typeof body?.prompt === 'string' ? body.prompt : undefined,
      whenToUse: typeof body?.whenToUse === 'string' ? body.whenToUse : undefined,
      modelInvocable: typeof body?.modelInvocable === 'boolean' ? body.modelInvocable : true,
      userInvocable: typeof body?.userInvocable === 'boolean' ? body.userInvocable : true,
      tools: body?.tools, visibility: typeof body?.visibility === 'string' ? body.visibility : 'private',
      category: typeof body?.category === 'string' ? body.category : undefined,
    })
    return reply.code(201).send(skill)
  })

  /**
   * SKILL-V1.3:SKILL.md Import preflight(§19;无 DB 写入)。
   * multipart file → 解析预览(name/description/whenToUse/invocation flags)+ errors/warnings。
   */
  app.post('/api/skills/import/preflight', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const upload = await readImportUpload(req)
    if ('error' in upload) return reply.code(upload.statusCode).send({ error: upload.error })
    return skillService.preflightImport(toCtx(req.principal), upload.filename, upload.text)
  })

  /**
   * SKILL-V1.3:单个 SKILL.md Import。
   * preflight 全部通过 → 复用 skillService.create → status=draft,source_type='upload'。
   * 失败 → 不产生任何 DB 写入(§4/§18)。身份来自 authenticated context(§16)。
   */
  app.post('/api/skills/import', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const upload = await readImportUpload(req)
    if ('error' in upload) return reply.code(upload.statusCode).send({ error: upload.error })
    try {
      const skill = await skillService.importSkillMd(toCtx(req.principal), upload.filename, upload.text)
      return reply.code(201).send(skill)
    } catch (err) {
      return sendImportError(reply, (err as Error).message)
    }
  })

  app.patch('/api/skills/:id', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const { id } = req.params as { id: string }
    const body = req.body as Record<string, unknown> | undefined
    const ok = await skillService.update(toCtx(req.principal), id, {
      name: typeof body?.name === 'string' ? body.name : undefined,
      description: typeof body?.description === 'string' ? body.description : undefined,
      prompt: typeof body?.prompt === 'string' ? body.prompt : undefined,
      visibility: typeof body?.visibility === 'string' ? body.visibility : undefined,
      category: typeof body?.category === 'string' ? body.category : undefined,
    })
    if (!ok) return reply.code(404).send({ error: 'not-found' })
    return { ok: true }
  })

  app.post('/api/skills/:id/publish', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const { id } = req.params as { id: string }
    const ok = await skillService.publish(toCtx(req.principal), id)
    if (!ok) return reply.code(400).send({ error: 'publish-failed' })
    // publish 影响所有真实安装者,逐个刷新投影(不只 publisher 自己)。
    try { await rebuildProjectionsForSkill(id) } catch (err) {
      process.stderr.write(`[skill-projection] publish rebuild failed for ${id}: ${String(err)}\n`)
    }
    return { ok: true }
  })

  app.post('/api/skills/:id/unpublish', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const { id } = req.params as { id: string }
    const ok = await skillService.unpublish(toCtx(req.principal), id)
    if (!ok) return reply.code(400).send({ error: 'unpublish-failed' })
    // 撤回影响所有真实安装者,逐个刷新投影(已安装副本自动退出 Runtime catalog)。
    try { await rebuildProjectionsForSkill(id) } catch (err) {
      process.stderr.write(`[skill-projection] unpublish rebuild failed for ${id}: ${String(err)}\n`)
    }
    return { ok: true }
  })

  app.put('/api/skills/:id', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const { id } = req.params as { id: string }
    const body = req.body as Record<string, unknown> | undefined
    const data: Record<string, unknown> = {}
    for (const k of ['description', 'prompt', 'whenToUse', 'category', 'visibility'] as const) {
      if (typeof body?.[k] === 'string') data[k] = body[k]
    }
    if (typeof body?.modelInvocable === 'boolean') data.modelInvocable = body.modelInvocable
    if (typeof body?.userInvocable === 'boolean') data.userInvocable = body.userInvocable
    if (body?.tools !== undefined) data.tools = body.tools
    try {
      const r = await skillService.saveAuthorEdit(toCtx(req.principal), id, data as never)
      if (r.version !== undefined) {
        try { await rebuildProjectionsForSkill(id) } catch (e) {
          process.stderr.write(`[skill-projection] edit rebuild failed for ${id}: ${String(e)}\n`)
        }
      }
      return r
    } catch (err) {
      if ((err as Error).message === 'not-found') return reply.code(404).send({ error: 'not-found' })
      throw err
    }
  })

  /** SKILL-V1.1:版本历史(owner-only;version/createdAt)。 */
  app.get('/api/skills/:id/versions', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const { id } = req.params as { id: string }
    try {
      return { versions: await skillService.listVersions(toCtx(req.principal), id) }
    } catch (err) {
      if ((err as Error).message === 'not-found') return reply.code(404).send({ error: 'not-found' })
      throw err
    }
  })

  app.post('/api/skills/:id/install', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const { id } = req.params as { id: string }
    const ok = await skillService.install(toCtx(req.principal), id)
    if (!ok) return reply.code(400).send({ error: 'install-failed' })
    await rebuildOwn(req.principal)
    return { ok: true }
  })

  app.delete('/api/skills/:id/install', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const { id } = req.params as { id: string }
    await skillService.uninstall(toCtx(req.principal), id)
    await rebuildOwn(req.principal)
    return { ok: true }
  })
}