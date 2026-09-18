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
import { ensureRuntime, shutdownRuntimes, startIdleReaper, probeDshLauncher } from './supervisor.js'

const app = Fastify({
  logger: true,
  trustProxy: true,
})

await app.register(cookie)
await app.register(rateLimit, { global: false })

const sessions = new SessionService(
  await createSessionStore({
    info: (m) => app.log.info(m),
    warn: (m) => app.log.warn(m),
  }),
)

/**
 * 平台自有 `/api/*` 路由(在 dsh UI authority 上必须由平台认证并处理)。
 *
 * 背景:dsh UI authority(localhost:8080)下,平台的 `/api/*` 路由与 dsh 自身的
 * RPC(`/api/session/*`、`/api/skills/list`、`/api/remote*` 等)共存。
 * 此表精确界定「平台 API」;其余 `/api/*` 走 dsh 代理。
 *
 * 03/04:必须精确匹配平台路由(资源 id 段限定为 UUID),否则会误捕获 dsh 的
 * `POST /api/skills/list`(skills Remote),对其施加平台 CSRF 校验而 403。
 * 这不是 auth 重写,只是路由归属界定。
 */
const UUID = '[0-9a-fA-F-]{36}'
const PLATFORM_API_PATTERNS: readonly RegExp[] = [
  /^\/api\/health$/,
  /^\/api\/workspaces(\/recreate)?$/,
  /^\/api\/sessions(\/(enter|migrate))?$/,
  /^\/api\/runtimes\/ensure$/,
  /^\/api\/skills$/,
  /^\/api\/skills\/installed$/,
  /^\/api\/skills\/runtime-status$/,
  new RegExp(`^/api/skills/${UUID}$`),
  new RegExp(`^/api/skills/${UUID}/(publish|install)$`),
  /^\/api\/knowledge-bases$/,
  new RegExp(`^/api/knowledge-bases/${UUID}/(documents|mount)$`),
  /^\/api\/knowledge\/(search|mounts|runtime-status)$/,
  /^\/api\/connectors$/,
  /^\/api\/connectors\/authorized$/,
  /^\/api\/connectors\/runtime-status$/,
  new RegExp(`^/api/connectors/${UUID}/(approve|authorize|disable|credential)$`),
  /^\/api\/memory$/,
  /^\/api\/memory\/namespaces$/,
  /^\/api\/memory\/runtime-status$/,
  new RegExp(`^/api/memory/${UUID}(/promote)?$`),
]

function isPlatformApiPath(path: string): boolean {
  return PLATFORM_API_PATTERNS.some((pattern) => pattern.test(path))
}

/**
 * /api/* 鉴权与 CSRF:
 * 注入 request.principal(已验证身份)供所有 handler 使用。
 * 禁止 handler 从 body/query/header 读取 userId。
 */
app.addHook('preHandler', async (req, reply) => {
  const path = (req.url.split('?')[0] ?? '')
  if (req.headers.host === config.dsh.uiAuthority && !isPlatformApiPath(path)) return
  if (!path.startsWith('/api/') || path === '/api/health') return
  const session = await sessions.readPrincipal(req)
  if (session === null) {
    await reply.code(401).send({ error: 'unauthenticated' })
    return
  }
  req.principal = session.principal
  const method = req.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    if (!sessions.verifyCsrf(req, session.csrfSecret)) {
      await reply.code(403).send({ error: 'csrf-failed', code: 'csrf-failed' })
      return
    }
  }
})

app.get('/api/health', async () => ({ ok: true, db: await ping() }))

registerAuthRoutes(app, sessions)
registerPlatformRoutes(app)
registerMemoryRoutes(app)
registerSkillRoutes(app)
registerKnowledgeRoutes(app)
registerMCPRoutes(app)

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
  await sessions.close()
})

await app.listen({ port: config.port, host: config.host }).then(
  (address) => app.log.info(`gateway listening on ${address} (session=${sessions.storeKind})`),
  (err: unknown) => {
    app.log.error(err)
    process.exit(1)
  },
)