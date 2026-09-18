import { randomBytes } from 'node:crypto'
import { Redis } from 'ioredis'
import type { UserRole } from '@dsh-platform/shared'
import { config } from '../config.js'

/** 服务端会话数据(platform 设计 §3.1:sid → {userId, deviceId, issuedAt, lastSeen})。 */
export interface SessionData {
  userId: string
  tenantId: string
  displayName: string
  role: UserRole
  deviceId: string
  /** CSRF 双提交 token 的服务端真值(§10)。 */
  csrfSecret: string
  issuedAt: number
  lastSeen: number
  /** 预留:批量吊销(§3.1 revocation_epoch)。 */
  revocationEpoch: number
}

export interface SessionStore {
  readonly kind: 'memory' | 'redis'
  create(data: SessionData, ttlMs: number): Promise<string>
  get(sid: string): Promise<SessionData | null>
  /** 刷新 lastSeen 与 TTL(滑动过期)。 */
  touch(sid: string, ttlMs: number): Promise<void>
  destroy(sid: string): Promise<void>
  close(): Promise<void>
  /** 旋转会话(sid 重铸,防固定)。 */
  rotate(sid: string, data: SessionData, ttlMs: number): Promise<string>
  /** 按用户吊销全部会话。 */
  revokeByUser(userId: string): Promise<void>
}

/** 32 字节随机 sid(base64url,URL 安全)。 */
export function newSid(): string {
  return randomBytes(32).toString('base64url')
}

class MemorySessionStore implements SessionStore {
  readonly kind = 'memory' as const
  private readonly map = new Map<string, { data: SessionData; expiresAt: number }>()

  private prune(now: number): void {
    for (const [sid, entry] of this.map) {
      if (entry.expiresAt <= now) this.map.delete(sid)
    }
  }

  async create(data: SessionData, ttlMs: number): Promise<string> {
    const sid = newSid()
    const now = Date.now()
    this.prune(now)
    this.map.set(sid, { data, expiresAt: now + ttlMs })
    return sid
  }

  async get(sid: string): Promise<SessionData | null> {
    const entry = this.map.get(sid)
    if (!entry) return null
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(sid)
      return null
    }
    return entry.data
  }

  async touch(sid: string, ttlMs: number): Promise<void> {
    const entry = this.map.get(sid)
    if (!entry) return
    entry.data.lastSeen = Date.now()
    entry.expiresAt = Date.now() + ttlMs
  }

  async destroy(sid: string): Promise<void> {
    this.map.delete(sid)
  }

  async rotate(sid: string, data: SessionData, ttlMs: number): Promise<string> {
    this.map.delete(sid)
    return this.create(data, ttlMs)
  }

  async revokeByUser(_userId: string): Promise<void> {
    const now = Date.now()
    for (const [sid, entry] of this.map) {
      if (entry.data.userId === _userId) {
        this.map.delete(sid)
      }
    }
  }

  async close(): Promise<void> {
    this.map.clear()
  }
}

class RedisSessionStore implements SessionStore {
  readonly kind = 'redis' as const
  constructor(private readonly redis: Redis) {}

  private key(sid: string): string {
    return `dsh:sid:${sid}`
  }

  async create(data: SessionData, ttlMs: number): Promise<string> {
    const sid = newSid()
    await this.redis.set(this.key(sid), JSON.stringify(data), 'PX', ttlMs)
    return sid
  }

  async get(sid: string): Promise<SessionData | null> {
    const raw = await this.redis.get(this.key(sid))
    if (raw === null) return null
    try {
      return JSON.parse(raw) as SessionData
    } catch {
      await this.redis.del(this.key(sid))
      return null
    }
  }

  async touch(sid: string, ttlMs: number): Promise<void> {
    const data = await this.get(sid)
    if (data === null) return
    data.lastSeen = Date.now()
    await this.redis.set(this.key(sid), JSON.stringify(data), 'PX', ttlMs)
  }

  async destroy(sid: string): Promise<void> {
    await this.redis.del(this.key(sid))
  }

  async rotate(sid: string, data: SessionData, ttlMs: number): Promise<string> {
    await this.redis.del(this.key(sid))
    const nextSid = newSid()
    await this.redis.set(this.key(nextSid), JSON.stringify(data), 'PX', ttlMs)
    return nextSid
  }

  async revokeByUser(userId: string): Promise<void> {
    // Redis 无按值遍历能力:生产应使用 user->sids 索引
    // 当前保留接口签名,实际由 SessionService 业务层处理
  }

  async close(): Promise<void> {
    await this.redis.quit()
  }
}

/**
 * 优先使用 Redis(platform 设计 §3.1);未配置或连接失败时降级到进程内存
 * (仅适合单实例开发,重启即失效)。返回的 store 附带告警日志。
 */
export async function createSessionStore(log: {
  info: (msg: string) => void
  warn: (msg: string) => void
}): Promise<SessionStore> {
  if (config.redisUrl === null) {
    log.info('session store: memory (REDIS_URL 未配置)')
    return new MemorySessionStore()
  }
  const redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
  })
  try {
    await redis.connect()
    await redis.ping()
    log.info(`session store: redis (${config.redisUrl})`)
    return new RedisSessionStore(redis)
  } catch (err) {
    redis.disconnect()
    log.warn(`session store: redis 连接失败,降级为 memory — ${(err as Error).message}`)
    return new MemorySessionStore()
  }
}
