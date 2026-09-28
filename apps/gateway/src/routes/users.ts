import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { UserService } from '../services/user-service.js'
import { UserManagementError } from '../services/user-validation.js'

export function registerUserRoutes(app: FastifyInstance, service: UserService): void {
  const handle = (operation: (req: FastifyRequest) => Promise<unknown>, success = 200) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.principal) return reply.code(401).send({ error: 'unauthenticated' })
    if (req.principal.role !== 'tenant_admin') return reply.code(404).send({ error: 'not-found' })
    req.principal = { ...req.principal, requestId: req.id }
    try { return reply.code(success).send(await operation(req)) } catch (err) {
      if (err instanceof UserManagementError) return reply.code(err.statusCode).send({ error: err.code })
      // 不记录 SQL、body 或原始异常（可含 password_hash/联系方式）。
      req.log.error({ requestId: req.id, operation: req.routeOptions.url }, 'user management failed')
      return reply.code(500).send({ error: 'user-management-failed' })
    }
  }
  const id = (req: FastifyRequest): string => {
    const value = (req.params as { id: string }).id
    if (!/^[0-9a-fA-F-]{36}$/.test(value)) throw new UserManagementError(404, 'not-found')
    return value
  }
  app.get('/api/admin/users', handle((req) => service.list(req.principal!, req.query)))
  app.post('/api/admin/users', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, handle((req) => service.create(req.principal!, req.body), 201))
  app.patch('/api/admin/users/:id', handle((req) => service.update(req.principal!, id(req), req.body)))
  app.delete('/api/admin/users/:id', handle((req) => service.remove(req.principal!, id(req))))
  app.post('/api/admin/users/:id/reset-password', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, handle((req) => service.resetPassword(req.principal!, id(req), req.body)))
}
