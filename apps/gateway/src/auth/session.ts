import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyReply } from 'fastify'
import type { AuthenticatedPrincipal, UserRole } from '@dsh-platform/shared'
import { config } from '../config.js'
import type { SessionData, SessionStore } from './session-store.js'

/**
 * 只依赖 cookie/headers 的结构化请求视图,避免与 Fastify 的 RawServer 泛型
 * (HTTP/1 与 HTTP/2 联合)产生不必要的类型耦合。
 */
export interface RequestLike {
  cookies: Record<string, string | undefined>
  headers: Record<string, string | string[] | undefined>
}

export interface AuthenticatedUser {
  userId: string
  tenantId: string
  displayName: string
  role: UserRole
}

const DEVICE_COOKIE = 'device_id'
const DEVICE_TTL_MS = 365 * 24 * 3600_000

/**
 * 浏览器会话服务(platform 设计 §3.1/§3.2):
 * sid cookie(HttpOnly、Secure、SameSite=Lax)→ Redis 会话;CSRF 双提交 token。
 */
export class SessionService {
  constructor(private readonly store: SessionStore) {}

  get storeKind(): string {
    return this.store.kind
  }

  /** 读取并滑动续期;无有效会话返回 null。 */
  async read(req: RequestLike): Promise<SessionData | null> {
    const sid = req.cookies[config.session.cookieName]
    if (sid === undefined || sid === '') return null
    const data = await this.store.get(sid)
    if (data === null) return null
    await this.store.touch(sid, config.session.ttlMs)
    return data
  }

  /** 登录成功:创建会话并下发 sid + csrf cookie。sid 每次登录重铸(防固定)。 */
  async establish(reply: FastifyReply, user: AuthenticatedUser, deviceId: string): Promise<SessionData> {
    const now = Date.now()
    const data: SessionData = {
      userId: user.userId,
      tenantId: user.tenantId,
      displayName: user.displayName,
      role: user.role,
      deviceId,
      csrfSecret: randomBytes(32).toString('base64url'),
      issuedAt: now,
      lastSeen: now,
      revocationEpoch: 0,
    }
    const sid = await this.store.create(data, config.session.ttlMs)
    const domain = config.session.cookieDomain
    reply.setCookie(config.session.cookieName, sid, {
      path: '/',
      httpOnly: true,
      secure: config.session.cookieSecure,
      sameSite: config.session.sameSite,
      maxAge: Math.floor(config.session.ttlMs / 1000),
      ...(domain === null ? {} : { domain }),
    })
    // CSRF cookie 必须可被前端 JS 读取(双提交),故非 HttpOnly。
    reply.setCookie(config.session.csrfCookieName, data.csrfSecret, {
      path: '/',
      httpOnly: false,
      secure: config.session.cookieSecure,
      sameSite: config.session.sameSite,
      maxAge: Math.floor(config.session.ttlMs / 1000),
      ...(domain === null ? {} : { domain }),
    })
    return data
  }

  /** 注销:删除服务端会话并清 cookie(§3.3)。 */
  async destroy(req: RequestLike, reply: FastifyReply): Promise<void> {
    const sid = req.cookies[config.session.cookieName]
    if (sid !== undefined && sid !== '') await this.store.destroy(sid)
    const domain = config.session.cookieDomain
    const clearOpts = domain === null ? { path: '/' } : { path: '/', domain }
    reply.clearCookie(config.session.cookieName, clearOpts)
    reply.clearCookie(config.session.csrfCookieName, clearOpts)
  }

  /** 恒定时间比对 CSRF 双提交 token(§10)。 */
  verifyCsrf(req: RequestLike, csrfSecret: string): boolean {
    const header = req.headers[config.session.csrfHeaderName]
    const provided = Array.isArray(header) ? header[0] : header
    if (typeof provided !== 'string' || provided === '') return false
    const expected = Buffer.from(csrfSecret)
    const actual = Buffer.from(provided)
    if (expected.length !== actual.length) return false
    return timingSafeEqual(expected, actual)
  }

  /** 读取或生成稳定的设备标识 cookie(多设备同步的 device_id)。 */
  resolveDeviceId(req: RequestLike, reply: FastifyReply): string {
    const existing = req.cookies[DEVICE_COOKIE]
    if (existing !== undefined && existing !== '') return existing
    const deviceId = randomBytes(16).toString('base64url')
    reply.setCookie(DEVICE_COOKIE, deviceId, {
      path: '/',
      httpOnly: true,
      secure: config.session.cookieSecure,
      sameSite: config.session.sameSite,
      maxAge: Math.floor(DEVICE_TTL_MS / 1000),
    })
    return deviceId
  }

  /** 从会话数据和 sid 构建已验证身份。 */
  buildPrincipal(sid: string, data: SessionData): AuthenticatedPrincipal {
    return {
      tenantId: data.tenantId,
      userId: data.userId,
      role: data.role,
      displayName: data.displayName,
      sessionId: sid,
      deviceId: data.deviceId,
    }
  }

  /** 一次性完成:读取 sid → 鉴权 → 滑动续期 → 构建身份。返回 null 表示未认证。 */
  async readPrincipal(req: RequestLike): Promise<{ principal: AuthenticatedPrincipal; csrfSecret: string } | null> {
    const sid = req.cookies[config.session.cookieName]
    if (sid === undefined || sid === '') return null
    const data = await this.store.get(sid)
    if (data === null) return null
    await this.store.touch(sid, config.session.ttlMs)
    return {
      principal: this.buildPrincipal(sid, data),
      csrfSecret: data.csrfSecret,
    }
  }

  async close(): Promise<void> {
    await this.store.close()
  }
}
