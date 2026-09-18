/**
 * Runtime → Gateway internal mutation channel(认证)。
 *
 * 设计:
 * - 每个用户 Runtime 启动时生成一次性 ephemeral token(仅内存)。
 * - 注入 child env `PLATFORM_MEMORY_INTERNAL_TOKEN` / `PLATFORM_MEMORY_INTERNAL_URL`。
 * - 插件调用 `/internal/memory/*` 时带 `x-runtime-token`。
 * - Gateway 用 token 反查 runtime → userId/tenantId,不接受请求体指定身份。
 * - Runtime 退出/重启即失效并轮换;绝不落 DB/浏览器/日志。
 */
import { randomBytes } from 'node:crypto'

interface RuntimeIdentity {
  userId: string
  tenantId: string
  createdAt: number
}

const tokens = new Map<string, RuntimeIdentity>()
const byUser = new Map<string, string>()

/** 生成/轮换某 runtime 的 ephemeral token。返回 token 明文(仅用于 child env 注入)。 */
export function issueRuntimeToken(userId: string, tenantId: string): string {
  revokeRuntimeToken(userId)
  const token = randomBytes(32).toString('base64url')
  tokens.set(token, { userId, tenantId, createdAt: Date.now() })
  byUser.set(userId, token)
  return token
}

export function revokeRuntimeToken(userId: string): void {
  const existing = byUser.get(userId)
  if (existing !== undefined) {
    tokens.delete(existing)
    byUser.delete(userId)
  }
}

/** 解析 token → 身份;无效/未知返回 null。 */
export function resolveRuntimeToken(token: string): RuntimeIdentity | null {
  if (token === '') return null
  return tokens.get(token) ?? null
}
