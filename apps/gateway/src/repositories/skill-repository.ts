import type { TenantContext, Skill, SkillVersion, SkillInstallation, SkillSearchInput, SkillVisibility, SkillStatus } from '@dsh-platform/shared'
import type { SqlValue } from '../db.js'
import { randomUUID } from 'node:crypto'
import { execute, queryMany, queryOne } from '../db.js'

interface SkillRow {
  id: string; tenantId: string; creatorId: string; name: string; slug: string
  description: string | null; prompt: string | null; tools: unknown
  visibility: string; status: string; latestVersion: string; category: string | null
  sourceType: string | null; sourceUrl: string | null; usageCount: number; installCount: number
  createdAt: string; updatedAt: string
}

const SKILL_COLS = `id, tenant_id AS tenantId, creator_id AS creatorId, name, slug,
  description, prompt, tools, visibility, status, latest_version AS latestVersion,
  category, source_type AS sourceType, source_url AS sourceUrl,
  usage_count AS usageCount, install_count AS installCount,
  created_at AS createdAt, updated_at AS updatedAt`

function toSkill(r: SkillRow): Skill {
  return { ...r, visibility: r.visibility as SkillVisibility, status: r.status as SkillStatus, tools: r.tools ?? null }
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

    return { skills: rows.map(toSkill), total: countRow?.total ?? 0 }
  }

  async findById(ctx: TenantContext, skillId: string): Promise<Skill | undefined> {
    const row = await queryOne<SkillRow>(
      `SELECT ${SKILL_COLS} FROM t_dsh_skills WHERE id = ? AND (
        visibility = 'public' OR (visibility = 'tenant' AND tenant_id = ?) OR creator_id = ?
      )`, [skillId, ctx.tenantId, ctx.userId])
    return row ? toSkill(row) : undefined
  }

  async findOwned(ctx: TenantContext, skillId: string): Promise<Skill | undefined> {
    const row = await queryOne<SkillRow>(`SELECT ${SKILL_COLS} FROM t_dsh_skills WHERE id = ? AND creator_id = ?`,
      [skillId, ctx.userId])
    return row ? toSkill(row) : undefined
  }

  async create(ctx: TenantContext, data: { name: string; slug: string; description?: string; prompt?: string; tools?: unknown; visibility?: SkillVisibility; category?: string }): Promise<Skill> {
    const id = randomUUID()
    await execute(
      `INSERT INTO t_dsh_skills (id, tenant_id, creator_id, name, slug, description, prompt, tools, visibility, status, category)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
      [id, ctx.tenantId, ctx.userId, data.name, data.slug, data.description ?? null, data.prompt ?? null,
       data.tools ? JSON.stringify(data.tools) : null, data.visibility ?? 'private', data.category ?? null])
    return this.findById(ctx, id) as unknown as Skill
  }

  async update(ctx: TenantContext, skillId: string, data: Partial<{ name: string; description: string; prompt: string; tools: unknown; visibility: SkillVisibility; category: string }>): Promise<boolean> {
    const sets: string[] = []; const params: SqlValue[] = []
    if (data.name !== undefined) { sets.push('name = ?'); params.push(data.name) }
    if (data.description !== undefined) { sets.push('description = ?'); params.push(data.description) }
    if (data.prompt !== undefined) { sets.push('prompt = ?'); params.push(data.prompt) }
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
    return rows.map(toSkill)
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
    id: string; slug: string; name: string; description: string | null; prompt: string | null; version: string
  }>> {
    return queryMany<{ id: string; slug: string; name: string; description: string | null; prompt: string | null; version: string }>(
      `SELECT s.id, s.slug, s.name, s.description, s.prompt, i.version
         FROM t_dsh_skills s
         JOIN t_dsh_skill_installations i ON i.skill_id = s.id
        WHERE i.user_id = ? AND i.enabled = 1 AND s.status = 'published'
        ORDER BY s.updated_at DESC`, [userId])
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
}

export const skillRepository = new SkillRepository()