/**
 * 四个正式全局 Panel 的注册表。
 *
 * id(sidebar.panellist 的 id)== main keyed slot 的 key,必须一致。
 * `cmcc.smoke` 不在本表(不再作为普通用户入口;仅测试 fixture 引用其 id 断言不存在)。
 */
import * as React from 'react'
import { SkillPanel } from './SkillPanel.js'
import { KnowledgePanel } from './KnowledgePanel.js'
import { McpPanel } from './McpPanel.js'
import { MemoryPanel } from './MemoryPanel.js'
import { UsagePanel } from './UsagePanel.js'

export type PanelId = 'cmcc.skills' | 'cmcc.knowledge' | 'cmcc.mcp' | 'cmcc.memory' | 'cmcc.usage'

export interface PanelDef {
  id: PanelId
  label: string
  order: number
  Icon: (props: { size?: number; active?: boolean }) => React.ReactElement
  Component: () => React.ReactElement
  adminOnly?: boolean
}

function icon(path: React.ReactNode): (props: { size?: number; active?: boolean }) => React.ReactElement {
  return function PanelIcon(props: { size?: number; active?: boolean }): React.ReactElement {
    const size = props.size ?? 18
    const color = props.active === true ? '#1a6dff' : 'currentColor'
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ display: 'block' }}>
        <g fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          {path}
        </g>
      </svg>
    )
  }
}

const SkillsIcon = icon(
  <>
    <path d="M12 3l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L4.8 8.3l5-.7L12 3z" />
  </>,
)

const KnowledgeIcon = icon(
  <>
    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5V5.5z" />
    <path d="M19 18v3H6.5" />
    <path d="M8 7h7M8 10.5h7" />
  </>,
)

const McpIcon = icon(
  <>
    <circle cx="6" cy="6" r="2.4" />
    <circle cx="18" cy="6" r="2.4" />
    <circle cx="12" cy="18" r="2.4" />
    <path d="M7.6 7.7l3.2 8M16.4 7.7l-3.2 8M8.4 6h7.2" />
  </>,
)

const MemoryIcon = icon(
  <>
    <path d="M12 4a4 4 0 0 1 3.9 3.1A3.5 3.5 0 0 1 17 13.6V18a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-4.4A3.5 3.5 0 0 1 8.1 7.1 4 4 0 0 1 12 4z" />
    <path d="M12 8v9" />
  </>,
)

const UsageIcon = icon(
  <>
    <path d="M4 20V11M10 20V5M16 20v-8M22 20V8" />
    <path d="M2 20h20" />
  </>,
)

export const PANELS: readonly PanelDef[] = [
  { id: 'cmcc.skills', label: '技能广场', order: 100, Icon: SkillsIcon, Component: SkillPanel },
  { id: 'cmcc.knowledge', label: '知识中心', order: 110, Icon: KnowledgeIcon, Component: KnowledgePanel },
  { id: 'cmcc.mcp', label: 'MCP 服务', order: 120, Icon: McpIcon, Component: McpPanel },
  { id: 'cmcc.memory', label: '我的记忆', order: 130, Icon: MemoryIcon, Component: MemoryPanel },
  { id: 'cmcc.usage', label: '用量统计', order: 140, Icon: UsageIcon, Component: UsagePanel, adminOnly: true },
]
