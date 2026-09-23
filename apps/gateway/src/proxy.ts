import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import http from 'node:http'
import type { Http2ServerRequest } from 'node:http2'
import type {
  FastifyInstance, FastifyReply, FastifyRequest,
  RequestGenericInterface, RawServerBase,
} from 'fastify'
import httpProxy from '@fastify/http-proxy'
import { config } from './config.js'
import { ensureRuntime, getRuntime } from './supervisor.js'
import type { RuntimeInfo } from './supervisor.js'
import { auditRepository } from './repositories/audit-repository.js'
import { seedUserSessions } from './session-sync.js'
import type { SessionService } from './auth/session.js'

/** http-proxy/reply-from 回调收到的请求类型(HTTP/1 与 HTTP/2 联合)。 */
type ProxyRequest = FastifyRequest<
  RequestGenericInterface,
  RawServerBase,
  IncomingMessage | Http2ServerRequest
>

/**
 * 注入 Host = 实例声明的 authority(dsh UI 的 authority)。
 * dsh 的 /api 围栏要求 Host 为 loopback 或匹配 --trusted-host;
 * 带 Origin 的浏览器请求还要求 Origin 与 Host authority 相等 —— 因此必须保持
 * 浏览器原始 Origin 并把 Host 覆写为同一 authority。
 *
 * bootstrap 与后续 API/WS 使用**完全相同**的 authority 策略(见 ADR-0001)。
 */
function upstreamHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const next: IncomingHttpHeaders = { ...headers }
  next.host = config.dsh.uiAuthority
  return next
}

/** 请求路径(去掉 query)。 */
function requestPath(req: ProxyRequest): string {
  return req.url.split('?')[0] ?? ''
}

/** 浏览器是否已持有 dsh 浏览器会话 cookie(`dsh-auth-<authority hash>`)。 */
function hasDshAuthCookie(cookieHeader: string | undefined): boolean {
  if (cookieHeader === undefined || cookieHeader === '') return false
  return /(?:^|;\s*)dsh-auth-/.test(cookieHeader)
}

/**
 * 是否需要 launch-token bootstrap:
 * - 仅 dsh 0.1.5+(runtime 持有内存 launch token)
 * - 仅 root index(`/`)
 * - 平台 session 变化(切换账号)或浏览器尚无 dsh 浏览器会话 cookie
 *
 * 以平台 session 为准,而非仅看 cookie:dsh cookie 按 authority 命名、不含用户,
 * 同一浏览器切换平台账号时必须重新换取该 runtime 的 cookie。
 */
function shouldBootstrap(req: ProxyRequest, runtime: RuntimeInfo, sessionId: string): boolean {
  if (runtime.launchToken === null) return false
  if (requestPath(req) !== '/') return false
  if (runtime.lastBootstrappedSid === sessionId && hasDshAuthCookie(req.headers.cookie)) return false
  return true
}

interface BootstrapResult {
  status: number
  location: string | null
  setCookies: string[]
}

/**
 * Gateway→DSH 的一次性 token 交换:
 * `GET <upstream>/?token=<launchToken>`,**不 follow** 303。
 * token 只存在于这条 upstream 请求,浏览器 URL 永不出现。
 *
 * 必须用 `node:http`(而非 fetch/undici):undici 禁止覆盖 `Host` 头,
 * 会导致 DSH 把浏览器 cookie 绑定到 `127.0.0.1:<port>` 而不是平台 authority,
 * 后续经代理的请求(带 `Host: <authority>`)就会 401。
 */
function exchangeLaunchToken(runtime: RuntimeInfo): Promise<BootstrapResult> {
  return new Promise<BootstrapResult>((resolve, reject) => {
    const token = runtime.launchToken
    if (token === null) {
      reject(new Error('launch token missing'))
      return
    }
    const url = new URL(runtime.upstreamUrl)
    const req = http.request(
      {
        host: url.hostname,
        port: Number(url.port),
        path: `/?token=${encodeURIComponent(token)}`,
        method: 'GET',
        // 与代理阶段完全一致的 authority 策略(ADR-0001)。
        headers: { host: runtime.authority, accept: 'text/html' },
      },
      (res) => {
        const raw = res.headers['set-cookie']
        const setCookies = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
        const location = res.headers.location
        resolve({
          status: res.statusCode ?? 502,
          location: typeof location === 'string' ? location : null,
          setCookies,
        })
        res.resume()
      },
    )
    req.setTimeout(10_000, () => { req.destroy(new Error('launch-token exchange timeout')) })
    req.on('error', reject)
    req.end()
  })
}

/**
 * 串行化同一 runtime 的 bootstrap,避免并发 root 请求同时消费 token。
 * 每个请求仍各自执行一次交换(不同浏览器需要各自的 cookie)。
 */
async function withBootstrapLock<T>(runtime: RuntimeInfo, fn: () => Promise<T>): Promise<T> {
  const previous = runtime.bootstrapInFlight ?? Promise.resolve()
  let release: () => void = () => {}
  const current = new Promise<void>((resolve) => { release = resolve })
  runtime.bootstrapInFlight = current
  await previous
  try {
    return await fn()
  } finally {
    release()
    if (runtime.bootstrapInFlight === current) runtime.bootstrapInFlight = null
  }
}

/**
 * dsh Web UI 反向代理(platform 设计 §3.2/§8,含 WS 升级)。
 *
 * 拓扑:dsh 前端使用根绝对路径(/assets、/api...),无法挂在子路径下,
 * 故每个用户的 UI 挂在专属 authority(PLATFORM_DSH_UI_AUTHORITY)的根;网关按 Host 约束路由。
 * 未认证时 302 到平台首页登录(dsh 实例无登录页)。
 *
 * dsh 0.1.5+ 引入进程级 launch-token 浏览器认证:浏览器始终访问干净的 `/`,
 * 网关在需要时把首条 root 请求的 upstream 改写为 `GET /?token=...`,并把
 * 303 + Location + Set-Cookie **原样转发**给浏览器(不 follow)。
 */
export function registerDshUiProxy(app: FastifyInstance, sessions: SessionService): void {
  const loginUrl = `${config.platform.scheme}://${config.platform.authority}/login`

  const preHandler = async (req: ProxyRequest, reply: FastifyReply): Promise<void> => {
    const session = await sessions.readPrincipal(req)
    if (session === null) {
      await reply.code(302).header('location', loginUrl).send()
      return
    }
    const principal = session.principal
    try {
      const __t0 = performance.now()
      const __preExisting = getRuntime(principal.userId)
      const __wasReady = __preExisting !== undefined && __preExisting.state === 'ready'
      app.log.info(`[timing] RUNTIME_ENSURE_BEGIN user=${principal.userId} preState=${__wasReady ? 'ready' : (__preExisting !== undefined ? __preExisting.state : 'absent')}`)
      const runtime = await ensureRuntime(principal)
      const __waitMs = Math.round(performance.now() - __t0)
      const __state = __wasReady ? 'hit' : (__waitMs > 50 ? 'wait' : 'spawn')
      app.log.info(`[timing] RUNTIME_ENSURE_HIT resolved=${__state === 'hit'}`)
      app.log.info(`[timing] BACKEND_RECEIVE path=${requestPath(req)} ensureRuntime_state=${__state} waitMs=${__waitMs}`)
      req.platformRuntime = runtime
      req.principal = principal
      void seedUserSessions(principal.userId, principal.tenantId)

      // launch-token bootstrap:仅 root index + 需要时。
      if (shouldBootstrap(req, runtime, principal.sessionId)) {
        const result = await withBootstrapLock(runtime, () => exchangeLaunchToken(runtime))
        if (result.status >= 300 && result.status < 400 && result.setCookies.length > 0) {
          // 交换成功:记录该平台会话已 bootstrap,后续请求走普通代理。
          runtime.lastBootstrappedSid = principal.sessionId
        }
        reply.code(result.status)
        if (result.location !== null) reply.header('location', result.location)
        if (result.setCookies.length > 0) reply.header('set-cookie', result.setCookies)
        await reply.send()
        return
      }
    } catch (err) {
      app.log.error({ err, userId: principal.userId }, 'ensureRuntime failed')
      await auditRepository.write({
        action: 'runtime.ensure',
        subject: `runtime spawn failed for ${principal.userId}`,
        payload: { message: (err as Error).message },
      })
      await reply.code(502).send({ error: 'runtime-unavailable', code: 'runtime-unavailable' })
    }
  }

  app.register(httpProxy, {
    // 动态上游:真实上游由 getUpstream 按用户实例返回;'' 使 WS 路径也走 getUpstream。
    upstream: '',
    prefix: '/',
    websocket: true,
    // 仅在 dsh UI 的 Host 上生效(平台首页/API 在其它 Host)。
    // Fastify host 约束按完整 Host 匹配(含端口),故用 authority(host[:port])。
    constraints: { host: config.dsh.uiAuthority },
    preHandler,
    replyOptions: {
      getUpstream: (req: ProxyRequest): string =>
        req.platformRuntime?.upstreamUrl ?? 'http://127.0.0.1:1',
      rewriteRequestHeaders: (_req: ProxyRequest, headers: IncomingHttpHeaders): IncomingHttpHeaders =>
        upstreamHeaders(headers),
    },
    wsClientOptions: {
      /**
       * WS 上游握手头:`@fastify/http-proxy` 的 WS 版 `rewriteRequestHeaders(headers, request)`
       * 第一个参数是默认头对象(`wsClientOptions.headers`,通常为 `{}`),**不是**客户端请求头。
       * 必须从 `request.headers` 取客户端头(Origin / Cookie / Sec-WebSocket-*)并覆写 Host,
       * 否则 dsh 因缺少 Origin/会话 cookie 对 WS 升级返回非 101 → 代理以 1011 关闭。
       */
      rewriteRequestHeaders: (_headers: IncomingHttpHeaders, req: ProxyRequest): IncomingHttpHeaders =>
        upstreamHeaders(req.headers),
    },
  })
}
