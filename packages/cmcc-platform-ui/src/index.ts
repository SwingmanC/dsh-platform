/**
 * cmcc-platform-ui Host 半区。
 *
 * 本包是纯 client 插件:UI 逻辑在 `src/client/index.tsx`(经官方 client bundle
 * 约定构建为 `lib/client.js`)。Host 半区无业务逻辑,只作为 dsh 插件图的入口。
 */
export const name = 'cmcc-platform-ui'

export function apply(): void {
  // 无 Host 侧逻辑。
}
