/**
 * cmcc-platform Skill Runtime Provider 的官方契约镜像(local structural types)。
 *
 * 真源:tag `dsh-v0.1.5-rc.2` `@deepseek-ai/dsh-skill/lib/types/index.d.ts`。
 * 本包为 Host-only 插件,运行在 DSH 进程内;为避免把 dsh 包作为 workspace 依赖,
 * 这里镜像所需结构,注册时与官方 `ctx.skills.registerProvider` 对接。
 * 详见 docs/implementation/REWORK-04-skill-contract.md。
 */

export type SkillSource =
  | 'project-dsh' | 'project-agents' | 'runtime' | 'user-dsh' | 'user-agents' | 'custom' | 'bundled' | (string & {})

export type SkillResourceBase =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'opaque'; readonly description: string }

export interface SkillInvocationPolicy {
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}

export interface SkillSummary {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillInvocationPolicy
  readonly source: SkillSource
  readonly provider: string
  readonly resourceBase?: SkillResourceBase
}

export interface SkillCandidate extends SkillSummary {
  readonly rank: number
  readonly locator: unknown
  readonly path?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface SkillDefinition extends SkillSummary {
  readonly content: string
  readonly path?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface SkillLookupOptions {
  readonly cwd?: string | undefined
  readonly signal?: AbortSignal | undefined
}

export interface SkillProvider {
  readonly name: string
  readonly list: (options: SkillLookupOptions) => Promise<readonly SkillCandidate[] | { readonly candidates: readonly SkillCandidate[]; readonly complete: boolean }>
  readonly get: (candidate: SkillCandidate, options: SkillLookupOptions) => Promise<SkillDefinition | undefined>
}

export interface SkillProviderControl {
  readonly signal: AbortSignal
  readonly invalidate: () => void
}

/** 平台安装 Skill 的优先级 rank(见 ADR-0002-skill-precedence.md)。 */
export const CMCC_PLATFORM_SKILL_RANK = 350
