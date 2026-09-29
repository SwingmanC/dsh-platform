import type { TenantContext, Skill, SkillSearchInput, SkillVisibility, SkillImportPreflight } from '@dsh-platform/shared'
import { auditMutation } from './audit-service.js'
import { randomUUID } from 'node:crypto'
import { skillRepository } from '../repositories/skill-repository.js'
import { rebuildProjectionsForSkill, SKILL_NAME_RE } from '../skill-projection.js'
import { parseSkillMd, SkillMdFormatError, SKILL_MD_MAX_CHARS } from '../skill-format.js'

/** SKILL-V1.3:允许的 SKILL.md 文件扩展名(内容合法性仍由 parseSkillMd 决定,不依赖 MIME)。 */
export const SKILL_IMPORT_EXTENSIONS = new Set(['md', 'markdown'])

export class SkillService {
  async search(ctx: TenantContext, input: SkillSearchInput): Promise<{ skills: Skill[]; total: number }> {
    return skillRepository.search(ctx, input)
  }

  async get(ctx: TenantContext, skillId: string): Promise<Skill | undefined> {
    return skillRepository.findById(ctx, skillId)
  }

  async create(ctx: TenantContext, data: {
    name: string; description?: string; prompt?: string; whenToUse?: string
    modelInvocable?: boolean; userInvocable?: boolean
    tools?: unknown; visibility?: string; category?: string; sourceType?: string
  }): Promise<Skill> {
    const base = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const slug = base === '' ? `skill-${randomUUID().slice(0, 8)}` : base
    return auditMutation(ctx, 'skill.create', undefined, () => skillRepository.create(ctx, {
      ...data,
      slug,
      visibility: data.visibility as Skill['visibility'],
      whenToUse: data.whenToUse,
      modelInvocable: data.modelInvocable,
      userInvocable: data.userInvocable,
    }))
  }

  async update(ctx: TenantContext, skillId: string, data: Partial<{
    name: string; description: string; prompt: string; tools: unknown; visibility: string; category: string
  }>): Promise<boolean> {
    return auditMutation(ctx, 'skill.update', skillId, () => skillRepository.update(ctx, skillId, { ...data, visibility: data.visibility as Skill['visibility'] }))
  }

  async publish(ctx: TenantContext, skillId: string): Promise<boolean> {
    return auditMutation(ctx, 'skill.publish', skillId, () => skillRepository.publish(ctx, skillId))
  }

  /** 撤回(owner-only);投影由路由层统一 rebuild(所有安装者)。 */
  async unpublish(ctx: TenantContext, skillId: string): Promise<boolean> {
    return skillRepository.unpublish(ctx, skillId)
  }

  async install(ctx: TenantContext, skillId: string): Promise<boolean> {
    return auditMutation(ctx, 'skill.install', skillId, () => skillRepository.install(ctx, skillId))
  }

  async uninstall(ctx: TenantContext, skillId: string): Promise<boolean> {
    return auditMutation(ctx, 'skill.uninstall', skillId, () => skillRepository.uninstall(ctx, skillId))
  }

  async listInstalled(ctx: TenantContext): Promise<Skill[]> {
    return skillRepository.listInstalled(ctx)
  }

  /**
   * SKILL-V1.1:作者编辑(owner-only)。
   * - meta(description/category/visibility)即时生效;
   * - 正文(prompt)变更 → 原子化版本推进(bumpVersionTx)+ 已安装行版本同步(FOLLOW_LATEST)
   *   + 投影重建(所有安装者 body 更新);
   * - 无 prompt 变更 → 不产生新版本。
   */
  async   saveAuthorEdit(ctx: TenantContext, skillId: string, data: {
    description?: string; prompt?: string; whenToUse?: string
    modelInvocable?: boolean; userInvocable?: boolean
    tools?: unknown; category?: string; visibility?: string
  }): Promise<{ ok: true; version?: string }> {
    const owned = await skillRepository.findOwned(ctx, skillId)
    if (!owned) throw new Error('not-found')
    const meta: { description?: string; category?: string; visibility?: SkillVisibility } = {}
    if (data.description !== undefined) meta.description = data.description
    if (data.category !== undefined) meta.category = data.category
    if (data.visibility !== undefined && ['private', 'tenant', 'public'].includes(data.visibility)) {
      meta.visibility = data.visibility as SkillVisibility
    }
    if (Object.keys(meta).length > 0) {
      await skillRepository.update(ctx, skillId, {
        ...meta,
        ...(meta.visibility !== undefined ? { visibility: meta.visibility as SkillVisibility } : {}),
      })
    }

    // SKILL-V1.2:runtime metadata(whenToUse/invocation flags)属于版本内容 —— 变更即版本推进
    const metadataChanged = (data.whenToUse !== undefined && data.whenToUse !== (owned.whenToUse ?? ''))
      || (data.modelInvocable !== undefined && data.modelInvocable !== owned.modelInvocable)
      || (data.userInvocable !== undefined && data.userInvocable !== owned.userInvocable)
    let version: string | undefined
    if (data.prompt !== undefined && data.prompt.trim() !== '') {
      version = await skillRepository.bumpVersionTx(
        skillId,
        data.prompt,
        {
          whenToUse: data.whenToUse ?? owned.whenToUse ?? undefined,
          modelInvocable: data.modelInvocable ?? owned.modelInvocable,
          userInvocable: data.userInvocable ?? owned.userInvocable,
        },
        data.tools ?? owned.tools,
      )
      await skillRepository.updateInstallationsVersion(skillId, version)
      await rebuildProjectionsForSkill(skillId)
    } else if (metadataChanged) {
      // 仅 runtime metadata 变更:同样推进版本(改变 Runtime Skill 行为)
      version = await skillRepository.bumpVersionTx(
        skillId,
        owned.prompt ?? '',
        {
          whenToUse: data.whenToUse ?? owned.whenToUse ?? undefined,
          modelInvocable: data.modelInvocable ?? owned.modelInvocable,
          userInvocable: data.userInvocable ?? owned.userInvocable,
        },
        data.tools ?? owned.tools,
      )
      await skillRepository.updateInstallationsVersion(skillId, version)
      await rebuildProjectionsForSkill(skillId)
    }
    return { ok: true, ...(version !== undefined ? { version } : {}) }
  }

  /** SKILL-V1.1:版本历史(owner-only;version/createdAt,不含 diff/rollback)。 */
  async listVersions(ctx: TenantContext, skillId: string): Promise<Array<{ version: string; createdAt: string }>> {
    const owned = await skillRepository.findOwned(ctx, skillId)
    if (!owned) throw new Error('not-found')
    const rows = await skillRepository.listVersions(ctx, skillId)
    return rows.map((r) => ({ version: r.version, createdAt: r.createdAt }))
  }

  // ------------------------------------------------------------------
  // SKILL-V1.3:单个 SKILL.md Import + Preflight
  //
  // - 复用 V1.2 parseSkillMd(唯一 parser source of truth;禁止第二套 parser)
  // - preflight 全部完成后才允许任何 DB 写入(§4/§18);任何失败 → 不产生
  //   Skill/Version/Installation
  // - 成功 → 走现有 skillService.create(复用 persistence;status=draft;
  //   初始版本语义 = Create 语义 latest_version=1.0.0,不建独立 Import 路径)
  // - source_type 记录现有枚举值 'upload'(schema 注释:'local'|'git'|'upload'|'market'),
  //   不为 Import 修改 schema
  // - metadata 键:IMPORT_METADATA = IGNORED_UNSUPPORTED(parser 容忍该键,
  //   平台不导入其内容;不做部分导入,无未知状态)
  // ------------------------------------------------------------------

  /** 文本长度护栏(§6:复用 SKILL_MD_MAX_CHARS,不引入不同限制)。 */
  static readonly IMPORT_MAX_CHARS = SKILL_MD_MAX_CHARS

  private static extensionOf(filename: string): string {
    return filename.split('.').pop()?.toLowerCase() ?? ''
  }

  /**
   * 共享 preflight:按顺序检查 file type → size → parse → body → name 规则 → duplicate。
   * 返回 canonical(成功)或受控错误码(失败)。不做任何 DB 写入。
   */
  private async runImportPreflight(ctx: TenantContext, filename: string, text: string): Promise<{ canonical: ReturnType<typeof parseSkillMd>; slug: string } | { error: string }> {
    if (typeof filename !== 'string' || !SKILL_IMPORT_EXTENSIONS.has(SkillService.extensionOf(filename))) {
      return { error: 'invalid-skill-file' }
    }
    if (typeof text !== 'string' || text.length > SkillService.IMPORT_MAX_CHARS) {
      return { error: 'skill-file-too-large' }
    }
    let canonical: ReturnType<typeof parseSkillMd>
    try {
      canonical = parseSkillMd(text)
    } catch (err) {
      if (err instanceof SkillMdFormatError) {
        return { error: err.code === 'skill-md-too-large' ? 'skill-file-too-large' : err.code }
      }
      throw err
    }
    // §9:空正文默认拒绝(现有 Create contract 未明确允许空 prompt;Import 拒绝缺失正文)
    if (canonical.prompt.trim() === '') return { error: 'missing-body' }
    // §7:复用 SKILL_NAME_RE,不放宽
    if (!SKILL_NAME_RE.test(canonical.name)) return { error: 'invalid-name' }
    const slug = canonical.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if (await skillRepository.findDuplicateForCreator(ctx.userId, canonical.name, slug)) {
      return { error: 'duplicate-skill-name' }
    }
    return { canonical, slug }
  }

  /** §19:preflight API(无 DB 写入;返回解析预览 + errors/warnings)。 */
  async preflightImport(ctx: TenantContext, filename: string, text: string): Promise<SkillImportPreflight> {
    const result = await this.runImportPreflight(ctx, filename, text)
    if ('error' in result) {
      return {
        valid: false, name: null, description: null, whenToUse: null,
        modelInvocable: null, userInvocable: null,
        warnings: [], errors: [result.error],
      }
    }
    const c = result.canonical
    return {
      valid: true, name: c.name, description: c.description, whenToUse: c.whenToUse ?? null,
      modelInvocable: c.modelInvocable, userInvocable: c.userInvocable,
      warnings: [], errors: [],
    }
  }

  /**
   * Import:preflight 成功 → 复用现有 create(persistence 逻辑唯一;
   * create 为单条 INSERT,天然原子,不留 half-created 状态)。
   */
  async importSkillMd(ctx: TenantContext, filename: string, text: string): Promise<Skill> {
    const result = await this.runImportPreflight(ctx, filename, text)
    if ('error' in result) throw new Error(result.error)
    const c = result.canonical
    return this.create(ctx, {
      name: c.name,
      description: c.description,
      prompt: c.prompt,
      whenToUse: c.whenToUse,
      modelInvocable: c.modelInvocable,
      userInvocable: c.userInvocable,
      visibility: 'private',
      sourceType: 'upload',
    })
  }
}

export const skillService = new SkillService()