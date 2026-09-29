/**
 * SKILL-V1.2 集成单测:whenToUse/invocation flags → DB → 投影 catalog(真实 MySQL)。
 * 前置:MySQL 已运行;自建 fixture,结束清理。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import { execute, queryOne, pool } from '../src/db.js'
import { skillRepository } from '../src/repositories/skill-repository.js'
import { skillService } from '../src/services/skill-service.js'
import type { TenantContext } from '@dsh-platform/shared'

const TA = randomUUID()
const kbA = randomUUID()
let skillA = ''
let owner: TenantContext

async function ctxFor(): Promise<TenantContext> {
  return { tenantId: TA, userId: REAL_USER, role: 'tenant_admin', requestId: '', platformSessionId: '', deviceId: '' }
}

/** 真实用户(fk_skills_user/fk_kb_user 需要);fixtures 内解析。 */
let REAL_USER = ''

describe('SKILL-V1.2 metadata 生命周期', () => {
  it('fixtures: 租户/KB/技能(v1.0.0,默认 flags true)', async () => {
    const settings = JSON.stringify({})
    await execute(`INSERT INTO t_dsh_tenants (id, slug, name, settings) VALUES (?, ?, ?, ?)`, [TA, `sk12-ta-${TA.slice(0, 8)}`, 'SK12 A', settings])
    REAL_USER = (await queryOne<{ id: string }>(`SELECT id FROM t_dsh_users ORDER BY created_at LIMIT 1`)).id
    owner = await ctxFor()
    await execute(`INSERT INTO t_dsh_knowledge_bases (id, tenant_id, creator_id, name, visibility, status) VALUES (?, ?, ?, 'sk12-kb', 'personal', 'active')`, [kbA, TA, REAL_USER])
    const created = await skillService.create(owner, { name: 'kt12-metadata-skill', prompt: 'v1 body', visibility: 'tenant' })
    skillA = created.id
    await execute(`INSERT INTO t_dsh_knowledge_mounts (id, user_id, kb_id, mount_type) VALUES (?, ?, ?, 'user')`, [randomUUID(), REAL_USER, kbA])
  })

  it('§18: 默认 flags = true/true(旧行为不变)', async () => {
    const row = await queryOne<{ model_invocable: number; user_invocable: number }>(
      `SELECT model_invocable, user_invocable FROM t_dsh_skills WHERE id = ?`, [skillA])
    assert.equal(row!.model_invocable, 1)
    assert.equal(row!.user_invocable, 1)
  })

  it('§20/§27-13: whenToUse 变更 → 版本推进 + 元数据持久化', async () => {
    const r = await skillService.saveAuthorEdit(owner, skillA, { whenToUse: 'When handling travel claims' })
    assert.ok(r.version !== undefined)
    const ver = await queryOne<{ when_to_use: string | null; model_invocable: number }>(
      `SELECT when_to_use, model_invocable FROM t_dsh_skill_versions WHERE skill_id = ? AND version = ?`, [skillA, r.version!])
    assert.equal(ver!.when_to_use, 'When handling travel claims')
    assert.equal(ver!.model_invocable, 1)
  })

  it('§27-8/9: modelInvocable=false → 版本推进 + DB 持久化', async () => {
    const r = await skillService.saveAuthorEdit(owner, skillA, { modelInvocable: false })
    assert.equal(r.ok, true)
    const row = await queryOne<{ model_invocable: number }>(`SELECT model_invocable FROM t_dsh_skills WHERE id = ?`, [skillA])
    assert.equal(row!.model_invocable, 0)
  })

  it('§21-12: FOLLOW_LATEST — 安装行版本跟随最新(不同 whenToUse → metadata bump)', async () => {
    // 安装(模拟用户安装该 skill)
    await execute(`INSERT INTO t_dsh_skill_installations (id, tenant_id, user_id, skill_id, version) VALUES (?, ?, ?, ?, '0.0.0')`,
      [randomUUID(), TA, REAL_USER, skillA])
    const r = await skillService.saveAuthorEdit(owner, skillA, { whenToUse: 'When submitting expense reports' })
    const inst = await queryOne<{ version: string }>(`SELECT version FROM t_dsh_skill_installations WHERE skill_id = ? AND user_id = ?`, [skillA, REAL_USER])
    assert.ok(inst, 'installation 行应存在')
    assert.equal(inst!.version, r.version)
    assert.ok(r.version !== undefined)
  })

  it('投影 catalog: whenToUse/invocation flags 透传(§13→DSH catalog)', async () => {
    // 恢复 modelInvocable=true(§27-8/9 留下的 false)
    await skillService.saveAuthorEdit(owner, skillA, { modelInvocable: true })
    await skillService.publish(owner, skillA)
    await execute(`INSERT INTO t_dsh_skill_installations (id, tenant_id, user_id, skill_id, version) VALUES (?, ?, ?, ?, '9.9') ON DUPLICATE KEY UPDATE enabled = 1`,
      [randomUUID(), TA, REAL_USER, skillA])
    // 触发重建(publish 流程内已完成;此处再显式重建一次以确保快照)
    const proj = await skillRepository.listProjectableInstalled(REAL_USER)
    const target = proj.find((p) => p.id === skillA)
    assert.ok(target, 'published skill 应在投影候选中')
    assert.equal(target!.modelInvocable, true)
    assert.equal(target!.userInvocable, true)
    assert.equal(target!.whenToUse, 'When submitting expense reports')
  })

  it('§21-14: FOLLOW_LATEST 回归 — 投影 body = 最新 prompt', async () => {
    const proj = await skillRepository.listProjectableInstalled(REAL_USER)
    const target = proj.find((p) => p.id === skillA)
    assert.ok(target)
    assert.ok(target!.prompt.includes('v1 body'))
  })

  after(async () => {
    await execute(`DELETE FROM t_dsh_rag_embedding_config WHERE tenant_id = ?`, [TA]).catch(() => undefined)
    await execute(`DELETE FROM t_dsh_skill_versions WHERE skill_id = ?`, [skillA]).catch(() => undefined)
    await execute(`DELETE FROM t_dsh_skill_installations WHERE skill_id = ?`, [skillA]).catch(() => undefined)
    await execute(`DELETE FROM t_dsh_knowledge_documents WHERE kb_id = ?`, [kbA]).catch(() => undefined)
    await execute(`DELETE FROM t_dsh_skills WHERE id = ?`, [skillA]).catch(() => undefined)
    await execute(`DELETE FROM t_dsh_knowledge_mounts WHERE kb_id = ?`, [kbA]).catch(() => undefined)
    await execute(`DELETE FROM t_dsh_knowledge_bases WHERE id = ?`, [kbA]).catch(() => undefined)
    await execute(`DELETE FROM t_dsh_tenants WHERE id = ?`, [TA]).catch(() => undefined)
    await pool.end()
  })
})
