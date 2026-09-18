/**
 * cmcc-skill-provider —— CMCC 平台 Skill Runtime Provider(Host-only dsh 插件)。
 *
 * 读取 Gateway 写入的用户级 Skill 投影目录,经官方 `ctx.skills.registerProvider`
 * 投影为 DSH Skill Registry 的候选与 body。
 *
 * 契约:tag `dsh-v0.1.5-rc.2` `@deepseek-ai/dsh-skill`。见 REWORK-04-skill-contract.md。
 * 纪律:不直接访问 DB、不持有密码、不读平台 cookie/launch token;只读投影文件。
 */
import type { SkillProvider, SkillProviderControl } from './contract.js'
import { ProjectionSkillProvider } from './projection-reader.js'
import { watchCatalog } from './watcher.js'

export const name = 'cmcc-skill-provider'

/** cordis service 依赖:官方 Skill Registry。 */
export const inject = ['skills'] as const

interface SkillsService {
  registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void
}

interface PluginContext {
  skills: SkillsService
}

export function apply(ctx: PluginContext): void {
  const dir = process.env.PLATFORM_SKILL_PROJECTION_DIR
  if (dir === undefined || dir === '') return

  ctx.skills.registerProvider((control) => {
    // watcher 生命周期绑定 provider 注册(control.signal abort 即关闭)。
    watchCatalog(dir, control.signal, () => control.invalidate())
    return new ProjectionSkillProvider(dir, control)
  })
}
