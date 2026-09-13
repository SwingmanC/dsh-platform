/**
 * platform-identity Host 插件骨架(platform 设计 §4.1)。
 *
 * Supervisor 拉起实例时注入 env:PLATFORM_USER_ID、PLATFORM_USER_DISPLAY、
 * PLATFORM_GATEWAY_ORIGIN;插件经 Typert Remote 暴露只读的
 * platform.whoami(): { userId, displayName }。
 * 同 bundle 还应包含:cwd 根校验(拒绝用户根之外的 workspace)与
 * 单调 tool guard(会话 cwd 缺失时拒绝工具执行)——随 T3 落地。
 * 接入方式:profile patch 把本插件挂进每用户实例的组合(总方案 §6 L3)。
 */
export const name = 'platform-identity'

export class PlatformIdentityConfig {
  /** 骨架阶段无配置项;身份全部来自 env 注入。 */
}

export type PlatformIdentityContext = unknown

export function apply(_ctx: PlatformIdentityContext): void {
  // TODO(T3): 注册 platform.whoami() Remote(值取自 PLATFORM_USER_* env)。
}
