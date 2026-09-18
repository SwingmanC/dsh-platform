/**
 * Skill 面板 model:真实 Skill 列表 / 搜索 / 创建 / 发布 / 安装 / 卸载。
 *
 * 仅调用现有平台 API。Runtime Projection 状态由 capability-status 静态声明。
 */
import type { Skill, SkillListResult } from './types.js'
import type { ResourceState } from './resource.js'
import { runLoad } from './resource.js'
import type { SkillRuntimeStatus } from '../platform-api.js'

export interface SkillApi {
  listSkills(query: { q?: string; limit?: number; offset?: number }): Promise<SkillListResult>
  listInstalledSkills(): Promise<{ skills: Skill[] }>
  createSkill(input: { name: string; description?: string; prompt?: string; visibility?: string }): Promise<Skill>
  publishSkill(id: string): Promise<{ ok: true }>
  installSkill(id: string): Promise<{ ok: true }>
  uninstallSkill(id: string): Promise<{ ok: true }>
  /** 可选:真实 Runtime 投影状态(不可用时不阻塞面板)。 */
  getSkillRuntimeStatus?(): Promise<SkillRuntimeStatus>
}

export interface SkillPanelData {
  skills: Skill[]
  total: number
  installedIds: string[]
  /** 真实 Runtime evidence;null = 无法获取(面板显示未知,不冒充)。 */
  runtime: SkillRuntimeStatus | null
}

export function loadSkills(api: SkillApi, query: { q?: string } = {}): Promise<ResourceState<SkillPanelData>> {
  return runLoad(async () => {
    const runtimePromise = typeof api.getSkillRuntimeStatus === 'function'
      ? api.getSkillRuntimeStatus().catch(() => null)
      : Promise.resolve(null)
    const [list, installed, runtime] = await Promise.all([
      api.listSkills({ q: query.q, limit: 50 }),
      api.listInstalledSkills(),
      runtimePromise,
    ])
    return {
      skills: list.skills,
      total: list.total,
      installedIds: installed.skills.map((s) => s.id),
      runtime,
    }
  }, (data) => data.skills.length === 0)
}

/** Runtime 状态文案(供 Skill Panel 诚实展示)。 */
export function skillRuntimeStateLabel(state: string): string {
  const map: Record<string, string> = {
    CONNECTED: '已同步', SYNCING: '同步中', ERROR: '错误',
    RUNTIME_STOPPED: 'Runtime 未运行', NOT_CONNECTED: '未接入',
  }
  return map[state] ?? state
}

export async function createSkillAndReload(
  api: SkillApi,
  input: { name: string; description?: string; prompt?: string; visibility?: string },
  query: { q?: string } = {},
): Promise<ResourceState<SkillPanelData>> {
  await api.createSkill(input)
  return loadSkills(api, query)
}

export async function installSkillAndReload(api: SkillApi, id: string, query: { q?: string } = {}): Promise<ResourceState<SkillPanelData>> {
  await api.installSkill(id)
  return loadSkills(api, query)
}

export async function uninstallSkillAndReload(api: SkillApi, id: string, query: { q?: string } = {}): Promise<ResourceState<SkillPanelData>> {
  await api.uninstallSkill(id)
  return loadSkills(api, query)
}

export async function publishSkillAndReload(api: SkillApi, id: string, query: { q?: string } = {}): Promise<ResourceState<SkillPanelData>> {
  await api.publishSkill(id)
  return loadSkills(api, query)
}

/** UI 辅助:平台状态标签(draft/published/...)。 */
export function skillStatusLabel(status: string): string {
  const map: Record<string, string> = {
    draft: '草稿', pending_review: '待审核', published: '已发布',
    rejected: '已拒绝', suspended: '已暂停', deprecated: '已弃用',
  }
  return map[status] ?? status
}

export function skillVisibilityLabel(visibility: string): string {
  const map: Record<string, string> = { private: '私有', tenant: '租户', public: '公开' }
  return map[visibility] ?? visibility
}
