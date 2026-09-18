/**
 * dsh MCP Connector Client Plugin
 * Sidebar footer button → MCP service list panel.
 * TODO: 接入 tsdown 构建管道后生效。
 */
export const name = 'ui-connector'
export const inject = ['slots']

export function apply(ctx: { slots: { inject(s: string, cb: () => void): void; register(opts: any, comp: any): void } }): void {
  // 待构建管道接入后实现
}