/**
 * dsh Knowledge Base Client Plugin
 * Sidebar footer button → KB list panel.
 * TODO: 接入 tsdown 构建管道后生效。
 */
export const name = 'ui-knowledge-base'
export const inject = ['slots']

export function apply(ctx: { slots: { inject(s: string, cb: () => void): void; register(opts: any, comp: any): void } }): void {
  // 待构建管道接入后实现
}