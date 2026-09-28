import type { FastifyInstance } from 'fastify'
import { isPlatformApiPath } from './auth/platform-auth.js'
import { auditRequestContext, auditService, type AuditAction } from './services/audit-service.js'

/** Explicit operation mapping. Successful business events are emitted by services. */
export function auditOperation(method: string, route: string): AuditAction | null {
  const operations: Record<string, AuditAction> = {
    'POST /auth/login': 'login.failed', 'POST /auth/logout': 'logout',
    'POST /api/admin/users': 'user.create', 'PATCH /api/admin/users/:id': 'user.update',
    'DELETE /api/admin/users/:id': 'user.delete', 'POST /api/admin/users/:id/reset-password': 'user.password.reset',
    'POST /api/skills': 'skill.create', 'PATCH /api/skills/:id': 'skill.update',
    'POST /api/skills/:id/publish': 'skill.publish', 'POST /api/skills/:id/install': 'skill.install',
    'DELETE /api/skills/:id/install': 'skill.uninstall',
    'POST /api/knowledge-bases': 'knowledge.create', 'POST /api/knowledge-bases/:id/documents': 'knowledge.document.upload',
    'POST /api/knowledge-bases/:id/mount': 'knowledge.mount', 'DELETE /api/knowledge-bases/:id/mount': 'knowledge.unmount',
    'POST /api/connectors': 'connector.create', 'POST /api/connectors/:id/approve': 'connector.approve',
    'POST /api/connectors/:id/disable': 'connector.disable', 'POST /api/connectors/:id/authorize': 'connector.authorize',
    'DELETE /api/connectors/:id/authorize': 'connector.revoke', 'PUT /api/connectors/:id/credential': 'connector.credential.rotate',
    'POST /api/memory': 'memory.create', 'DELETE /api/memory/:id': 'memory.delete', 'POST /api/memory/:id/promote': 'memory.promote',
    'POST /api/workspaces': 'workspace.create', 'POST /api/workspaces/recreate': 'workspace.recreate',
    'POST /api/sessions/enter': 'session.enter', 'POST /api/sessions/migrate': 'session.migrate',
    'POST /api/runtimes/ensure': 'runtime.ensure',
  }
  return operations[`${method} ${route}`] ?? null
}

export function registerAuditHooks(app: FastifyInstance): void {
  app.addHook('onRequest', (req, _reply, done) => {
    auditRequestContext.run({ request: req, actions: new Map() }, done)
  })
  app.addHook('onResponse', async () => {
    const context = auditRequestContext.getStore()
    if (context) { context.request = undefined; context.actions.clear() }
  })
  app.addHook('onSend', async (req, reply, payload) => {
    if (reply.statusCode < 400) return payload
    const context = auditRequestContext.getStore()
    const action = auditOperation(req.method, req.routeOptions.url ?? '')
      ?? ([401, 403, 404].includes(reply.statusCode) && isPlatformApiPath(req.url.split('?')[0] ?? '') ? 'security.access.denied' : null)
    if (!action) return payload
    // A committed mutation followed by an API failure is a separate follow-up failure.
    if (req.routeOptions.url === '/auth/login' && ['login.failed', 'login.locked', 'login.success'].some((a) => context?.actions.has(a))) return payload
    const outcome = context?.actions.get(action)
    const prior = outcome === 'SUCCESS'
    if (outcome && !prior) return payload
    if (prior && (reply.statusCode < 500 || context?.actions.has('projection.sync'))) return payload
    let reasonCode = `http-${reply.statusCode}`
    if (reply.statusCode === 401) reasonCode = 'unauthenticated'
    if (reply.statusCode === 403) reasonCode = 'permission-or-csrf-denied'
    if (reply.statusCode === 404) reasonCode = 'not-found-or-denied'
    const params = req.params as { id?: unknown } | undefined
    const record = () => auditService.write({ action: prior ? 'projection.sync' : action,
      resourceId: typeof params?.id === 'string' ? params.id : undefined,
      result: reply.statusCode >= 500 ? 'ERROR' : 'DENIED', reasonCode,
      payload: prior ? { syncStatus: 'failed' } : undefined })
    if (context?.request) await record()
    else await auditRequestContext.run({ request: req, actions: new Map() }, record)
    return payload
  })
}
