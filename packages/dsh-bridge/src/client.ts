/**
 * ui-platform-account Client 插件骨架(platform 设计 §4.2)。
 *
 * 在设置外壳(sidebar.settings 槽位区域)的设置入口旁注册账号条目:
 * 显示 whoami() 的 displayName(React 文本渲染,防注入;不展示 userId),
 * 点击弹出含「注销」的浮层 —— 调网关 POST /auth/logout(带 CSRF token)
 * 成功后跳转 /login。文案必须走类型化 locale 字典经 t 渲染
 * (dsh 仓库门禁 verify-client-ui-i18n 拒绝硬编码文案)。
 */
export const name = 'ui-platform-account'

export class PlatformAccountConfig {
  /** 网关地址;默认取 env PLATFORM_GATEWAY_ORIGIN 注入的值。 */
  gatewayOrigin = ''
}

export type PlatformAccountContext = unknown

export function apply(_ctx: PlatformAccountContext): void {
  // TODO(T3): 经 ui-slots 注册账号条目 + 注销浮层 + locale 词条。
}
