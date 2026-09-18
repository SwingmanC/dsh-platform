/**
 * platform-identity —— dsh Host 半区。
 *
 * 最小职责:读取 Supervisor 在 spawn 时注入的**可信 identity env**
 * (`PLATFORM_USER_ID` / `PLATFORM_USER_DISPLAY` / `PLATFORM_WORKSPACE_ROOT`)。
 *
 * 02C 契约修复:移除了历史猜测调用 `ctx.tools?.guard(...)`。
 * 官方 0.1.5-rc.2 确实存在 tool guard 扩展点
 * (`@deepseek-ai/dsh-tools` `ToolRuntime.guard(guard: ToolGuard)`,
 * `ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined`),
 * 但该执行对象没有已验证的 `cwd`/workspace 字段,历史签名 `(call:{name,cwd})` 是猜测;
 * 且当前平台无该 guard 的生产消费者,工作区越界已由 Gateway(`isWithinUserRoot`)
 * 与 dsh 自身 sandbox 围栏。因此按 02C 要求删除猜测调用,不保留未验证 API。
 *
 * 本阶段不 provide 新的 cordis service(暂无消费者);identity 仅作为可信输入读取。
 */
import path from 'node:path'

export const name = 'platform-identity'

export interface PlatformIdentity {
  userId: string
  displayName: string
}

/** 读取 Supervisor 注入的可信 identity;缺失时返回 null(不抛错)。 */
export function readIdentity(env: NodeJS.ProcessEnv = process.env): PlatformIdentity | null {
  const userId = env.PLATFORM_USER_ID
  if (!userId) return null
  return { userId, displayName: env.PLATFORM_USER_DISPLAY || userId }
}

/** candidate 是否位于 root 之下(root 为空视为不限制)。 */
export function isWithinRoot(candidate: string, root: string): boolean {
  if (!root) return true
  const rel = path.relative(path.resolve(root), path.resolve(candidate))
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

export function apply(): void {
  // 读取注入的 identity(存在即证明 Supervisor → Runtime env 通道有效)。
  // 无 Host 侧副作用;identity 的消费留待有真实消费者的阶段。
  readIdentity()
}
