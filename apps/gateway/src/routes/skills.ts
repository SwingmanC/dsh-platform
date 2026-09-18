import type { FastifyInstance } from 'fastify'
import type { AuthenticatedPrincipal, TenantContext, SkillSearchInput } from '@dsh-platform/shared'
import { skillService } from '../services/skill-service.js'
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
      tools: body?.tools, visibility: typeof body?.visibility === 'string' ? body.visibility : 'private',
      category: typeof body?.category === 'string' ? body.category : undefined,
    })
    return reply.code(201).send(skill)
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