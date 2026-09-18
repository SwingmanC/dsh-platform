/**
 * Runtime 能力状态声明(build capability declaration)。
 *
 * 重要:这是**构建期能力声明**,不是 runtime health,也不是从 UI 推断。
 * Phase 03 不实现 Skill Provider / Knowledge Adapter / MCP Projection / Memory Adapter;
 * 这些闭环属于 Phase 04–07。UI 必须如实展示,不得把 DB 状态冒充 Runtime 已生效。
 */

/** 平台侧状态:平台 API/DB 已就绪。 */
export type PlatformCapabilityStatus = 'PLATFORM_READY' | 'NOT_IMPLEMENTED' | 'ERROR'

/** Runtime 侧状态:是否已与 dsh Runtime 接通。 */
export type RuntimeCapabilityStatus = 'RUNTIME_CONNECTED' | 'RUNTIME_NOT_CONNECTED'

export interface CapabilityDeclaration {
  /** 人类可读能力名。 */
  name: string
  platform: PlatformCapabilityStatus
  runtime: RuntimeCapabilityStatus
  /** 具体缺口(供 UI 诚实展示)。 */
  gaps: readonly string[]
}

export type CapabilityKey = 'skill' | 'knowledge' | 'mcp' | 'memory'

export const CAPABILITIES: Record<CapabilityKey, CapabilityDeclaration> = {
  skill: {
    name: 'Skill',
    platform: 'PLATFORM_READY',
    // Phase 04:ctx.skills Provider 已实现;实时同步状态由 /api/skills/runtime-status 提供。
    runtime: 'RUNTIME_CONNECTED',
    gaps: [],
  },
  knowledge: {
    name: 'Knowledge',
    platform: 'PLATFORM_READY',
    // Phase 05:Knowledge Runtime Adapter 已接入;状态由 /api/knowledge/runtime-status 提供。
    runtime: 'RUNTIME_CONNECTED',
    gaps: [],
  },
  mcp: {
    name: 'MCP',
    platform: 'PLATFORM_READY',
    // Phase 06:MCP Runtime Projection 已接入(官方 dsh-mcp-client);状态由 /api/connectors/runtime-status 提供。
    runtime: 'RUNTIME_CONNECTED',
    gaps: [],
  },
  memory: {
    name: 'Memory',
    platform: 'PLATFORM_READY',
    // Phase 07:Memory Runtime Adapter 已接入(tools + bounded recall + extraction);状态由 /api/memory/runtime-status 提供。
    runtime: 'RUNTIME_CONNECTED',
    gaps: [],
  },
}

/** 供 UI 展示的 Runtime 状态文案。 */
export function runtimeBadgeLabel(key: CapabilityKey): string {
  const c = CAPABILITIES[key]
  return c.runtime === 'RUNTIME_CONNECTED' ? 'Runtime 已接入' : 'Runtime 未接入'
}
