import type { FastifyInstance } from 'fastify'
import type { RowDataPacket } from 'mysql2/promise'
import type { LoginRequest, LoginResponse, MeResponse, UserRole } from '@dsh-platform/shared'
import { queryOne } from '../db.js'
import { verifyPassword } from '../auth/password.js'
import type { SessionService } from '../auth/session.js'
import { checkLoginAllowed, clearLoginFailures, loginKey, recordLoginFailure } from '../auth/login-guard.js'
import { auditRepository } from '../repositories/audit-repository.js'

interface UserRow extends RowDataPacket {
  id: string
  tenantId: string
  displayName: string
  role: UserRole
  status: string
  passwordHash: string | null
}

const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$vfd11LJqb11tM5IkzXy2/A$PUrebjGDeZGnuHFpTbnVg6CSCDugzCbOS4fIQBXXnFs'

export function registerAuthRoutes(app: FastifyInstance, sessions: SessionService): void {
  app.post('/auth/login', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const body = req.body as Partial<LoginRequest> | undefined
    const email = typeof body?.email === 'string' ? body.email.trim() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    if (email === '' || password === '') {
      return reply.code(400).send({ error: 'invalid-request', code: 'credentials-required' })
    }

    const key = loginKey(email, req.ip)
    const gate = checkLoginAllowed(key)
    if (!gate.allowed) {
      const retryAfter = Math.ceil(gate.retryAfterMs / 1000)
      reply.header('retry-after', String(retryAfter))
      await auditRepository.write({ action: 'login.failed', subject: email, payload: { ip: req.ip, reason: 'locked' } })
      return reply.code(429).send({ error: 'too-many-attempts', code: 'locked', retryAfter })
    }

    const user = await queryOne<UserRow>(
      `SELECT id, tenant_id AS tenantId, display_name AS displayName, role, status,
              password_hash AS passwordHash
         FROM t_dsh_users
        WHERE email = ?
        LIMIT 1`, [email])

    const hash = user?.passwordHash ?? DUMMY_HASH
    const ok = await verifyPassword(hash, password)

    if (user === undefined || !ok) {
      const locked = recordLoginFailure(key)
      await auditRepository.write({
        action: locked ? 'login.failed' : 'login.failed',
        subject: email,
        payload: { ip: req.ip, locked },
      })
      return reply.code(401).send({ error: 'invalid-credentials' })
    }

    if (user.status !== 'active') {
      await auditRepository.write({ action: 'login.failed', subject: email, payload: { reason: 'disabled' } })
      return reply.code(403).send({ error: 'account-disabled', code: 'account-disabled' })
    }

    clearLoginFailures(key)
    const deviceId = sessions.resolveDeviceId(req, reply)
    await sessions.establish(reply, {
      userId: user.id, tenantId: user.tenantId, displayName: user.displayName, role: user.role,
    }, deviceId)
    await auditRepository.write({ action: 'login.success', subject: email, payload: { userId: user.id } })

    const response: LoginResponse = { userId: user.id, displayName: user.displayName, role: user.role }
    return reply.send(response)
  })

  app.get('/auth/me', async (req, reply) => {
    const session = await sessions.readPrincipal(req)
    if (session === null) return reply.code(401).send({ error: 'unauthenticated' })
    const response: MeResponse = { userId: session.principal.userId, displayName: session.principal.displayName, role: session.principal.role }
    return reply.send(response)
  })

  app.post('/auth/logout', async (req, reply) => {
    const session = await sessions.readPrincipal(req)
    if (session === null) return reply.code(401).send({ error: 'unauthenticated' })
    if (!sessions.verifyCsrf(req, session.csrfSecret)) {
      return reply.code(403).send({ error: 'csrf-failed', code: 'csrf-failed' })
    }
    await sessions.destroy(req, reply)
    await auditRepository.write({ action: 'logout', subject: session.principal.userId })
    return reply.code(302).header('location', '/login').send()
  })
}