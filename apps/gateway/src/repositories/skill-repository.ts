import type { TenantContext, Skill, SkillVersion, SkillInstallation, SkillSearchInput, SkillVisibility, SkillStatus } from '@dsh-platform/shared'
import type { SqlValue } from '../db.js'
import { randomUUID } from 'node:crypto'
import { execute, queryMany, queryOne, pool } from '../db.js'

interface SkillRow {
  id: string; tenantId: string; creatorId: string; name: string; slug: string
  description: string | null; prompt: string | null; whenToUse: string | null
  modelInvocable: number; userInvocable: number; tools: unknown
  visibility: string; status: string; latestVersion: string; category: string | null
  sourceType: string | null; sourceUrl: string | null; usageCount: number; installCount: number
  createdAt: string; updatedAt: string
}

const SKILL_COLS = `id, tenant_id AS tenantId, creator_id AS creatorId, name, slug,
  description, prompt, when_to_use AS whenToUse, model_invocable AS modelInvocable, user_invocable AS userInvocable,
  tools, visibility, status, latest_version AS latestVersion,
  category, source_type AS sourceType, source_url AS sourceUrl,
  usage_count AS usageCount, install_count AS installCount,
  created_at AS createdAt, updated_at AS updatedAt`

function toSkill(r: SkillRow, viewerUserId?: string): Skill {
  const out: Skill = { ...r, visibility: r.visibility as SkillVisibility, status: r.status as SkillStatus, tools: r.tools ?? null, modelInvocable: r.modelInvocable === 1, userInvocable: r.userInvocable === 1, isOwner: viewerUserId !== undefined ? r.creatorId === viewerUserId : undefined }
  return out
}

export class SkillRepository {
  async search(ctx: TenantContext, input: SkillSearchInput): Promise<{ skills: Skill[]; total: number }> {
    const conditions: string[] = []
    const params: SqlValue[] = []

    conditions.push(`(
      visibility = 'public'
      OR (visibility = 'tenant' AND tenant_id = ?)
      OR (creator_id = ?)
    )`)
    params.push(ctx.tenantId, ctx.userId)

    if (input.status) { conditions.push('status = ?'); params.push(input.status) }
    if (input.visibility) { conditions.push('visibility = ?'); params.push(input.visibility) }
    if (input.category) { conditions.push('category = ?'); params.push(input.category) }
    if (input.q) { conditions.push('(name LIKE ? OR description LIKE ?)'); params.push(`%${input.q}%`, `%${input.q}%`) }

    const limit = Math.min(input.limit ?? 20, 100)
    const offset = input.offset ?? 0
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const countRow = await queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM t_dsh_skills ${where}`, params)
    const rows = await queryMany<SkillRow>(`SELECT ${SKILL_COLS} FROM t_dsh_skills ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset])

    return { skills: rows.map((r) => toSkill(r, ctx.userId)), total: countRow?.total ?? 0 }
  }

  async findById(ctx: TenantContext, skillId: string): Promise<Skill | undefined> {
    const row = await queryOne<SkillRow>(
      `SELECT ${SKILL_COLS} FROM t_dsh_skills WHERE id = ? AND (
        visibility = 'public' OR (visibility = 'tenant' AND tenant_id = ?) OR creator_id = ?
      )`, [skillId, ctx.tenantId, ctx.userId])
    return row ? toSkill(row, ctx.userId) : undefined
  }

  async findOwned(ctx: TenantContext, skillId: string): Promise<Skill | undefined> {
    const row = await queryOne<SkillRow>(`SELECT ${SKILL_COLS} FROM t_dsh_skills WHERE id = ? AND creator_id = ?`,
      [skillId, ctx.userId])
    return row ? toSkill(row) : undefined
  }

  async create(ctx: TenantContext, data: { name: string; slug: string; description?: string; prompt?: string; whenToUse?: string; modelInvocable?: boolean; userInvocable?: boolean; tools?: unknown; visibility?: SkillVisibility; category?: string; sourceType?: string }): Promise<Skill> {
    const id = randomUUID()
    await execute(
      `INSERT INTO t_dsh_skills (id, tenant_id, creator_id, name, slug, description, prompt, when_to_use, model_invocable, user_invocable, tools, visibility, status, category, source_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      [id, ctx.tenantId, ctx.userId, data.name, data.slug, data.description ?? null, data.prompt ?? null,
       data.whenToUse ?? null, data.modelInvocable === false ? 0 : 1, data.userInvocable === false ? 0 : 1,
       data.tools ? JSON.stringify(data.tools) : null, data.visibility ?? 'private', data.category ?? null,
       data.sourceType ?? null])
    return this.findById(ctx, id) as unknown as Skill
  }

  /** SKILL-V1.3:creator 范围内同名/同 slug 重复检测(Import preflight 用;不放宽 name 规则)。 */
  async findDuplicateForCreator(userId: string, name: string, slug: string): Promise<boolean> {
    const row = await queryOne<{ id: string }>(
      `SELECT id FROM t_dsh_skills WHERE creator_id = ? AND (name = ? OR slug = ?) LIMIT 1`,
      [userId, name, slug])
    return row !== undefined
  }

  async update(ctx: TenantContext, skillId: string, data: Partial<{ name: string; description: string; prompt: string; whenToUse: string; modelInvocable: boolean; userInvocable: boolean; tools: unknown; visibility: SkillVisibility; category: string }>): Promise<boolean> {
    const sets: string[] = []; const params: SqlValue[] = []
    if (data.name !== undefined) { sets.push('name = ?'); params.push(data.name) }
    if (data.description !== undefined) { sets.push('description = ?'); params.push(data.description) }
    if (data.prompt !== undefined) { sets.push('prompt = ?'); params.push(data.prompt) }
    if (data.whenToUse !== undefined) { sets.push('when_to_use = ?'); params.push(data.whenToUse) }
    if (data.modelInvocable !== undefined) { sets.push('model_invocable = ?'); params.push(data.modelInvocable ? 1 : 0) }
    if (data.userInvocable !== undefined) { sets.push('user_invocable = ?'); params.push(data.userInvocable ? 1 : 0) }
    if (data.tools !== undefined) { sets.push('tools = ?'); params.push(JSON.stringify(data.tools)) }
    if (data.visibility !== undefined) { sets.push('visibility = ?'); params.push(data.visibility) }
    if (data.category !== undefined) { sets.push('category = ?'); params.push(data.category) }
    if (sets.length === 0) return false
    const affected = await execute(
      `UPDATE t_dsh_skills SET ${sets.join(', ')} WHERE id = ? AND creator_id = ?`, [...params, skillId, ctx.userId])
    return affected > 0
  }

  async publish(ctx: TenantContext, skillId: string): Promise<boolean> {
    const affected = await execute(
      `UPDATE t_dsh_skills SET status = 'published' WHERE id = ? AND creator_id = ? AND status = 'draft'`,
      [skillId, ctx.userId])
    return affected > 0
  }

  /**
   * 撤回(published→draft,owner-only)。
   * 已安装副本无需逐个处理:投影查询(listProjectableInstalled)过滤
   * `s.status='published'`,撤回 + 投影重建后自动退出所有用户的 Runtime。
   * 撤回后 install() 的 published 前置校验同时阻止新安装。
   */
  async unpublish(ctx: TenantContext, skillId: string): Promise<boolean> {
    const affected = await execute(
      `UPDATE t_dsh_skills SET status = 'draft' WHERE id = ? AND creator_id = ? AND status = 'published'`,
      [skillId, ctx.userId])
    return affected > 0
  }

  async install(ctx: TenantContext, skillId: string): Promise<boolean> {
    const skill = await queryOne<{ status: string; latestVersion: string }>(
      `SELECT status, latest_version AS latestVersion FROM t_dsh_skills WHERE id = ?`, [skillId])
    if (!skill || skill.status !== 'published') return false
    const id = randomUUID()
    await execute(
      `INSERT INTO t_dsh_skill_installations (id, tenant_id, user_id, skill_id, version, enabled)
       VALUES (?, ?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE enabled = 1`,
      [id, ctx.tenantId, ctx.userId, skillId, skill.latestVersion])
    await execute(`UPDATE t_dsh_skills SET install_count = install_count + 1 WHERE id = ?`, [skillId])
    return true
  }

  async uninstall(ctx: TenantContext, skillId: string): Promise<boolean> {
    const affected = await execute(
      `DELETE FROM t_dsh_skill_installations WHERE user_id = ? AND skill_id = ?`, [ctx.userId, skillId])
    return affected > 0
  }

  async listInstalled(ctx: TenantContext): Promise<Skill[]> {
    const rows = await queryMany<SkillRow>(
      `SELECT ${SKILL_COLS} FROM t_dsh_skills
       WHERE id IN (SELECT skill_id FROM t_dsh_skill_installations WHERE user_id = ? AND enabled = 1)
       ORDER BY updated_at DESC`, [ctx.userId])
    return rows.map((r) => toSkill(r, ctx.userId))
  }

  /** 某 Skill 的真实安装者列表(publish/version 变更后需刷新这些用户的投影)。 */
  async listInstallationOwners(skillId: string): Promise<Array<{ userId: string; tenantId: string }>> {
    return queryMany<{ userId: string; tenantId: string }>(
      `SELECT user_id AS userId, tenant_id AS tenantId
         FROM t_dsh_skill_installations WHERE skill_id = ? AND enabled = 1`, [skillId])
  }

  /**
   * 当前用户「已安装 + 已发布」的 Skill(含 body=prompt),供 Runtime 投影构建。
   * 安全边界在 SQL:按 user_id 过滤安装记录(owner),不在 JS 全表过滤。
   */
  async listProjectableInstalled(userId: string): Promise<Array<{
    id: string; slug: string; name: string; description: string | null; prompt: string | null
    whenToUse: string | null; modelInvocable: boolean; userInvocable: boolean; version: string
  }>> {
    const rows = await queryMany<{ id: string; slug: string; name: string; description: string | null; prompt: string | null; whenToUse: string | null; modelInvocable: number; userInvocable: number; version: string }>(
      `SELECT s.id, s.slug, s.name, s.description, s.prompt, s.when_to_use AS whenToUse,
              s.model_invocable AS modelInvocable, s.user_invocable AS userInvocable, i.version
         FROM t_dsh_skills s
         JOIN t_dsh_skill_installations i ON i.skill_id = s.id
        WHERE i.user_id = ? AND i.enabled = 1 AND s.status = 'published'
        ORDER BY s.updated_at DESC`, [userId])
    return rows.map((r) => ({
      id: r.id, slug: r.slug, name: r.name, description: r.description, prompt: r.prompt,
      whenToUse: r.whenToUse, modelInvocable: r.modelInvocable === 1, userInvocable: r.userInvocable === 1,
      version: r.version,
    }))
  }

  async createVersion(ctx: TenantContext, skillId: string, version: string, prompt: string, tools?: unknown): Promise<boolean> {
    const id = randomUUID()
    await execute(
      `INSERT INTO t_dsh_skill_versions (id, skill_id, version, prompt, tools)
       VALUES (?, ?, ?, ?, ?)`,
      [id, skillId, version, prompt, tools ? JSON.stringify(tools) : null])
    await execute(`UPDATE t_dsh_skills SET latest_version = ? WHERE id = ? AND creator_id = ?`,
      [version, skillId, ctx.userId])
    return true
  }

  /** SKILL-V1.1:版本号递增(patch 位 +1;沿用现有 X.Y.Z 格式,不引入 semver parser)。 */
  async listVersions(ctx: TenantContext, skillId: string): Promise<Array<{ version: string; prompt: string; whenToUse: string | null; modelInvocable: boolean; userInvocable: boolean; tools: unknown; createdAt: string }>> {
    // 仅 owner 可读(路由层守卫;owner 判定与 update 同源)
    const rows = await queryMany<{ version: string; prompt: string; when_to_use: string | null; model_invocable: number; user_invocable: number; tools: unknown; createdAt: string }>(
      `SELECT version, prompt, when_to_use, model_invocable, user_invocable, tools, created_at AS createdAt
         FROM t_dsh_skill_versions
        WHERE skill_id = ?
        ORDER BY created_at DESC`,
      [skillId])
    return rows.map((r) => ({
      version: r.version, prompt: r.prompt, tools: r.tools, createdAt: r.createdAt,
      whenToUse: r.when_to_use ?? null,
      modelInvocable: r.model_invocable === 1,
      userInvocable: r.user_invocable === 1,
    }))
  }

  /**
   * SKILL-V1.1:作者编辑正文 → 原子化版本推进。
   * 事务:FOR UPDATE 锁 skill 行读 latest_version → patch+1 →
   * INSERT versions + UPDATE skills(latest_version/prompt)。
   * 避免并发编辑产生重复版本号(§20)。
   */
  /** SKILL-V1.2:元数据(whenToUse/invocation flags)作为版本内容一并持久化。 */
  async bumpVersionTx(skillId: string, prompt: string, meta: { whenToUse?: string; modelInvocable: boolean; userInvocable: boolean }, tools: unknown): Promise<string> {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const [rows] = await conn.query(
        `SELECT latest_version FROM t_dsh_skills WHERE id = ? FOR UPDATE`,
        [skillId])
      const current = (rows as Array<{ latest_version: string }>)[0]?.latest_version
      if (current === undefined) throw new Error('skill-missing')
      const next = nextVersion(current)
      await conn.query(
        `UPDATE t_dsh_skills SET latest_version = ?, prompt = ?, when_to_use = ?, model_invocable = ?, user_invocable = ? WHERE id = ?`,
        [next, prompt, meta.whenToUse ?? null, meta.modelInvocable ? 1 : 0, meta.userInvocable ? 1 : 0, skillId])
      await conn.query(
        `INSERT INTO t_dsh_skill_versions (id, skill_id, version, prompt, when_to_use, model_invocable, user_invocable, tools) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomUUID(), skillId, next, prompt, meta.whenToUse ?? null, meta.modelInvocable ? 1 : 0, meta.userInvocable ? 1 : 0, tools ? JSON.stringify(tools) : null])
      await conn.commit()
      return next
    } catch (err) {
      await conn.rollback().catch(() => undefined)
      throw err
    } finally {
      conn.release()
    }
  }

  /** SKILL-V1.1:已安装行版本标签同步(FOLLOW_LATEST 语义;正文经投影重建同步)。 */
  async updateInstallationsVersion(skillId: string, version: string): Promise<void> {
    await execute(`UPDATE t_dsh_skill_installations SET version = ? WHERE skill_id = ?`, [version, skillId])
  }
}

export const skillRepository = new SkillRepository()

/** SKILL-V1.1:X.Y.Z patch 位 +1(非数值段按 0 处理;不引入 semver parser)。 */
export function nextVersion(current: string): string {
  const seg = String(current ?? '0.0.0').split('.')
  const patch = Number.parseInt(seg[2] ?? '0', 10)
  return `${seg[0] ?? '0'}.${seg[1] ?? '0'}.${(Number.isNaN(patch) ? 0 : patch) + 1}`
}