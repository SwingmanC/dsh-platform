/**
 * cmcc-platform-ui —— 中国移动能力中心(0.1.5-rc.2 官方 Client Plugin)。
 *
 * 注册四个正式全局 Panel 到 DSH 原生 Shell:
 *   sidebar.panellist(id) == main keyed(key)
 *     cmcc.skills     技能广场
 *     cmcc.knowledge  知识中心
 *     cmcc.mcp        MCP 服务
 *     cmcc.memory     我的记忆
 *
 * 另注册最小中国移动品牌层(sidebar.brand.mark / sidebar.brand.name,shadow 官方)。
 *
 * 契约来源:docs/implementation/REWORK-02C-client-contract.md。
 * 纪律:React 组件不接收 Cordis ctx;无 iframe / DOM hack / React Router / window.location。
 * `cmcc.smoke` 不再注册(仅测试断言其不存在)。
 */
import * as React from 'react'
import { PANELS } from './panels/registry.js'

export const name = 'cmcc-platform-ui'

/** cordis service 依赖(官方 module 导出名)。 */
export const inject = ['slots', 'layout'] as const

interface SlotsService {
  inject(slot: string, cb: () => (() => void) | void): void
  register(
    options: {
      name: string
      id?: string
      key?: string
      order?: number
      label?: string
      priority?: number
      inject?: () => Record<string, unknown>
    },
    component: (props: Record<string, unknown>) => React.ReactNode,
  ): () => void
}

interface ClientContext {
  slots: SlotsService
  layout: { selectPanel(panelId: string | null): void }
}

/** 最小中国移动品牌名(文字 mark,不使用未授权 Logo)。 */
function CmccBrandName(): React.ReactElement {
  return (
    <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: '0.02em' }}>
      中国移动 · 数智智能体平台
    </span>
  )
}

/** 最小品牌 mark:文字方章。 */
function CmccBrandMark(props: { size?: number }): React.ReactElement {
  const size = props.size ?? 24
  return (
    <span
      aria-label="中国移动"
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: size, height: size, borderRadius: 6, background: '#1a6dff', color: '#fff',
        fontSize: Math.round(size * 0.55), fontWeight: 700, lineHeight: 1,
      }}
    >
      移
    </span>
  )
}

export function apply(ctx: ClientContext): void {
  // 四个正式能力入口(sidebar id == main key)。
  ctx.slots.inject('sidebar.panellist', () => {
    const disposers = PANELS.map((panel) => ctx.slots.register(
      { name: 'sidebar.panellist', id: panel.id, order: panel.order, label: panel.label },
      panel.Icon as unknown as (props: Record<string, unknown>) => React.ReactNode,
    ))
    return () => { for (const d of disposers) d() }
  })
  ctx.slots.inject('main', () => {
    const disposers = PANELS.map((panel) => ctx.slots.register(
      { name: 'main', key: panel.id },
      panel.Component as unknown as (props: Record<string, unknown>) => React.ReactNode,
    ))
    return () => { for (const d of disposers) d() }
  })

  // 最小品牌层:shadow 官方默认(更低 priority 渲染)。
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.register({ name: 'sidebar.brand.mark', priority: -1 }, CmccBrandMark as unknown as (props: Record<string, unknown>) => React.ReactNode))
  ctx.slots.inject('sidebar.brand.name', () =>
    ctx.slots.register({ name: 'sidebar.brand.name', priority: -1 }, CmccBrandName as unknown as (props: Record<string, unknown>) => React.ReactNode))
}
