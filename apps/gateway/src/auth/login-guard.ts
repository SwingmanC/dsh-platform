import { config } from '../config.js'

interface Attempt {
  count: number
  windowStart: number
  lockedUntil: number
}

/**
 * 登录防爆破(platform 设计 §10):按 email+IP 计失败次数,
 * 超过阈值后在锁定时长内拒绝。进程内存实现;多实例部署应改 Redis(T2+)。
 */
const attempts = new Map<string, Attempt>()

export function loginKey(email: string, ip: string): string {
  return `${email.toLowerCase()}@${ip}`
}

export interface LoginGate {
  allowed: boolean
  retryAfterMs: number
}

export function checkLoginAllowed(key: string): LoginGate {
  const now = Date.now()
  const entry = attempts.get(key)
  if (entry === undefined) return { allowed: true, retryAfterMs: 0 }
  if (entry.lockedUntil > now) {
    return { allowed: false, retryAfterMs: entry.lockedUntil - now }
  }
  if (now - entry.windowStart > config.loginGuard.windowMs) {
    attempts.delete(key)
    return { allowed: true, retryAfterMs: 0 }
  }
  return { allowed: true, retryAfterMs: 0 }
}

/** 记录一次失败;达到阈值则锁定。返回是否本次触发锁定。 */
export function recordLoginFailure(key: string): boolean {
  const now = Date.now()
  const entry = attempts.get(key)
  if (entry === undefined || now - entry.windowStart > config.loginGuard.windowMs) {
    attempts.set(key, { count: 1, windowStart: now, lockedUntil: 0 })
    return false
  }
  entry.count += 1
  if (entry.count >= config.loginGuard.maxAttempts) {
    entry.lockedUntil = now + config.loginGuard.lockoutMs
    return true
  }
  return false
}

export function clearLoginFailures(key: string): void {
  attempts.delete(key)
}
