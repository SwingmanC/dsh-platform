import { closeAuditWriter } from './repositories/audit-repository.js'
import { registerPlatformAuthentication } from './auth/platform-auth.js'
import { registerAuditHooks } from './audit-hooks.js'
import { registerAuditRoutes } from './routes/audit.js'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import { config } from './config.js'
import { ping } from './db.js'
import { createSessionStore } from './auth/session-store.js'
import { SessionService } from './auth/session.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerPlatformRoutes } from './routes/platform.js'
import { registerDshUiProxy } from './proxy.js'
import { registerMemoryRoutes } from './routes/memory.js'
import { registerSkillRoutes } from './routes/skills.js'
import { registerKnowledgeRoutes } from './routes/knowledge.js'
import { registerMCPRoutes } from './routes/mcp.js'
import { registerUsageRoutes } from './routes/usage.js'
import { registerUserRoutes } from './routes/users.js'
import { UserService } from './services/user-service.js'
import { userRepository } from './repositories/user-repository.js'
import { revokeUserRuntime } from './supervisor.js'
import { ensureRuntime, shutdownRuntimes, startIdleReaper, probeDshLauncher } from './supervisor.js'

const app = Fastify({
  logger: true,
  trustProxy: config.trustedProxies.length ? config.trustedProxies : false,
})

await app.register(cookie)
await app.register(rateLimit, { global: false })

const sessions = new SessionService(
  await createSessionStore({
    info: (m) => app.log.info(m),
    warn: (m) => app.log.warn(m),
  }),
)

registerAuditHooks(app)
registerPlatformAuthentication(app, sessions)

app.get('/api/health', async () => ({ ok: true, db: await ping() }))

registerAuthRoutes(app, sessions)
registerPlatformRoutes(app)
registerMemoryRoutes(app)
registerSkillRoutes(app)
registerKnowledgeRoutes(app)
registerMCPRoutes(app)
registerUsageRoutes(app)
registerAuditRoutes(app)
registerUserRoutes(app, new UserService(userRepository, revokeUserRuntime))

app.post('/api/runtimes/ensure', async (req, reply) => {
  if (!req.principal) {
    return reply.code(401).send({ error: 'unauthenticated' })
  }
  try {
    const runtime = await ensureRuntime(req.principal)
    return { runtimeId: runtime.runtimeId, state: runtime.state }
  } catch (err) {
    app.log.error({ err }, 'ensureRuntime failed')
    return reply.code(502).send({ error: 'runtime-unavailable', code: 'runtime-unavailable' })
  }
})

registerDshUiProxy(app, sessions)

app.addHook('onReady', async () => {
  app.log.info(`dsh ui authority=${config.dsh.uiAuthority}`)
  // launcher 预检:显式配置 nodeBin/cliEntry 时验证 Node 与 DSH 版本,
  // 避免 0.1.5 在未受支持的 Node 上静默退出。
  const probe = await probeDshLauncher()
  if (probe.nodeVersion === null && probe.dshVersion === null) {
    app.log.info(`dsh launcher: PATH fallback (${config.dsh.bin})`)
  } else if (probe.ok) {
    app.log.info(`dsh launcher ok: node=${probe.nodeVersion} dsh=${probe.dshVersion}`)
  } else {
    app.log.error(`dsh launcher preflight FAILED: ${probe.error ?? 'unknown'} (node=${probe.nodeVersion ?? '?'} dsh=${probe.dshVersion ?? '?'})`)
  }
})

const stopReaper = startIdleReaper({
  info: (m) => app.log.info(m),
  error: (m) => app.log.error(m),
})

app.addHook('onClose', async () => {
  stopReaper()
  shutdownRuntimes()
  await closeAuditWriter()
  await sessions.close()
})

await app.listen({ port: config.port, host: config.host }).then(
  (address) => app.log.info(`gateway listening on ${address} (session=${sessions.storeKind})`),
  (err: unknown) => {
    app.log.error(err)
    process.exit(1)
  },
)
