import type { FastifyInstance } from 'fastify'
import type { SessionService } from './session.js'
import { config } from '../config.js'

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
  /^\/api\/usage\/summary$/,
  /^\/api\/admin\/users$/,
  new RegExp(`^/api/admin/users/${UUID}(/reset-password)?$`),
  new RegExp(`^/api/memory/${UUID}(/promote)?$`),
]

export function isPlatformApiPath(path: string): boolean {
  return PLATFORM_API_PATTERNS.some((pattern) => pattern.test(path))
}

/**
 * /api/* 鉴权与 CSRF:
 * 注入 request.principal(已验证身份)供所有 handler 使用。
 * 禁止 handler 从 body/query/header 读取 userId。
 */
export function registerPlatformAuthentication(app: FastifyInstance, sessions: SessionService): void {
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
}
