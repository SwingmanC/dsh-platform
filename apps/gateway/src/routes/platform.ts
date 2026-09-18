import type { FastifyInstance } from 'fastify'
import type {
  CreateWorkspaceRequest,
  SessionEnterRequest,
  SessionEnterResult,
  SessionListResponse,
  WorkspaceListResponse,
  WorkspaceRecreateRequest,
} from '@dsh-platform/shared'
import type { TenantContext } from '@dsh-platform/shared'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import { queryMany, queryOne, execute } from '../db.js'
import { auditRepository } from '../repositories/audit-repository.js'
import { workspaceRepository } from '../repositories/workspace-repository.js'
import { agentBindingRepository } from '../repositories/binding-repository.js'
import { userWorkspaceRoot, isWithinUserRoot, pathExists } from '../platform.js'

function toTenantContext(userId: string, tenantId: string): TenantContext {
  return { userId, tenantId, role: 'member', requestId: '', platformSessionId: '', deviceId: '' }
}

export function registerPlatformRoutes(app: FastifyInstance): void {
  app.get('/api/workspaces', async (req): Promise<WorkspaceListResponse> => {
    if (!req.principal) return { workspaces: [] }
    const rows = await workspaceRepository.listByOwner(toTenantContext(req.principal.userId, req.principal.tenantId))
    return { workspaces: rows }
  })

  app.post('/api/workspaces', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const body = req.body as Partial<CreateWorkspaceRequest> | undefined
    const name = typeof body?.name === 'string' ? body.name : ''
    try {
      const ws = await createWorkspace(req.principal, name)
      return reply.code(201).send(ws)
    } catch (err) {
      app.log.error({ err, name }, 'createWorkspace failed')
      return reply.code(400).send({ error: 'invalid-workspace-name', code: 'invalid-workspace-name' })
    }
  })

  app.get('/api/sessions', async (req): Promise<SessionListResponse> => {
    if (!req.principal) return { sessions: [] }
    return { sessions: await agentBindingRepository.listByOwner(toTenantContext(req.principal.userId, req.principal.tenantId)) }
  })

  app.post('/api/sessions/enter', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const ctx = toTenantContext(req.principal.userId, req.principal.tenantId)
    const body = req.body as Partial<SessionEnterRequest> | undefined
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    if (sessionId === '') return reply.code(400).send({ error: 'sessionId-required' })

    const binding = await agentBindingRepository.findOwned(ctx, sessionId)
    if (binding === undefined) return reply.code(404).send({ error: 'not-found' })

    const exists = await pathExists(binding.workspace)
    if (!exists) {
      await auditRepository.write({ action: 'session.enter', ctx, subject: binding.workspace })
      return reply.send({
        ok: false,
        reason: 'workspace-missing',
        workspace: { id: '', userId: ctx.userId, canonicalPath: binding.workspace, displayName: binding.workspace, lastUsedAt: null, archivedAt: null, missingSince: null },
      } satisfies SessionEnterResult)
    }

    await auditRepository.write({ action: 'session.enter', ctx, subject: sessionId })
    return reply.send({
      ok: true,
      sessionId,
      redirectUrl: `${config.platform.scheme}://${config.dsh.uiAuthority}/`,
    } satisfies SessionEnterResult)
  })

  app.post('/api/workspaces/recreate', async (req, reply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    const ctx = toTenantContext(req.principal.userId, req.principal.tenantId)
    const body = req.body as Partial<WorkspaceRecreateRequest> | undefined
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    if (sessionId === '') return reply.code(400).send({ error: 'sessionId-required' })

    const binding = await agentBindingRepository.findOwned(ctx, sessionId)
    if (binding === undefined) return reply.code(404).send({ error: 'not-found' })
    try {
      await recreateWorkspace(ctx.userId, ctx.tenantId, binding.workspace)
    } catch {
      return reply.code(400).send({ error: 'outside-root', code: 'outside-root' })
    }
    await auditRepository.write({ action: 'session.enter', ctx, subject: binding.workspace })
    return reply.send({ ok: true, redirectUrl: `${config.platform.scheme}://${config.dsh.uiAuthority}/` })
  })

  app.post('/api/sessions/migrate', async (_req, reply) => {
    return reply.code(501).send({
      error: 'not-implemented',
      code: 's2-requires-sdk',
      message: 'S2 迁移依赖 dsh SDK 会话创建;待 sdk-driver 接入后启用',
    })
  })
}

async function createWorkspace(principal: { userId: string; tenantId: string }, name: string) {
  const safe = sanitizeWorkspaceName(name)
  if (safe === null) throw new Error('invalid-workspace-name')
  const dir = path.join(userWorkspaceRoot(principal.userId, principal.tenantId), safe)
  if (!isWithinUserRoot(principal.userId, principal.tenantId, dir)) throw new Error('outside-root')
  await mkdir(dir, { recursive: true })
  const ctx = toTenantContext(principal.userId, principal.tenantId)
  return workspaceRepository.upsert(ctx, dir, safe)
}

async function recreateWorkspace(userId: string, tenantId: string, canonicalPath: string): Promise<void> {
  if (!isWithinUserRoot(userId, tenantId, canonicalPath)) throw new Error('outside-root')
  await mkdir(canonicalPath, { recursive: true })
  await execute(
    'UPDATE t_dsh_workspaces SET missing_since = NULL WHERE user_id = ? AND canonical_path = ?',
    [userId, canonicalPath],
  )
}

function sanitizeWorkspaceName(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed === '' || trimmed.length > 64) return null
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(trimmed)) return null
  if (trimmed === '.' || trimmed === '..') return null
  return trimmed
}