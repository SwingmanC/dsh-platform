/**
 * SKILL-V1.1 集成单测:作者编辑 + 版本生命周期(真实 MySQL,自建 fixture,结束清理)。
 * 前置:MySQL 已运行。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import { execute, queryOne, queryMany, pool } from '../src/db.js'
import { skillRepository } from '../src/repositories/skill-repository.js'
import { skillService } from '../src/services/skill-service.js'
import type { TenantContext } from '@dsh-platform/shared'

const TA = randomUUID()
const TB = randomUUID()
const kbA = randomUUID()
const skillA = randomUUID()
const UA = randomUUID()   // owner(tenant A)
const UB = randomUUID()   // tenant A 另一用户(非 owner)
const U2 = randomUUID()   // tenant B 用户

function ctxFor(tenantId: string, userId: string): TenantContext {
  return { tenantId, userId, role: 'member', requestId: '', platformSessionId: '', deviceId: '' }
}

describe('SKILL-V1.1 作者编辑 + 版本生命周期', () => {
  it('fixtures: 租户/用户/KB/技能(create v1.0.0)', async () => {
    const settings = JSON.stringify({})
    await execute(`INSERT INTO t_dsh_tenants (id, slug, name, settings) VALUES (?, ?, ?, ?)`, [TA, `sk11-ta-${TA.slice(0, 8)}`, 'SK11 A', settings])
    await execute(`INSERT INTO t_dsh_tenants (id, slug, name, settings) VALUES (?, ?, ?, ?)`, [TB, `sk11-tb-${TB.slice(0, 8)}`, 'SK11 B', settings])
    await execute(`INSERT INTO t_dsh_users (id, tenant_id, email, display_name, password_hash, role) VALUES (?, ?, ?, ?, 'x', 'member')`, [UA, TA, `sk11-ua@t`, 'SK11 UA'])
    await execute(`INSERT INTO t_dsh_users (id, tenant_id, email, display_name, password_hash, role) VALUES (?, ?, ?, ?, 'x', 'member')`, [UB, TA, `sk11-ub@t`, 'SK11 UB'])
    await execute(`INSERT INTO t_dsh_users (id, tenant_id, email, display_name, password_hash, role) VALUES (?, ?, ?, ?, 'x', 'member')`, [U2, TB, `sk11-u2@t`, 'SK11 U2'])
    await execute(`INSERT INTO t_dsh_knowledge_bases (id, tenant_id, creator_id, name, visibility, status) VALUES (?, ?, ?, 'sk11-kb', 'personal', 'active')`, [kbA, TA, UA])
    const owner = await ctxFor(TA, UA)
    await skillRepository.create(owner, { name: 'kt5-auto-skill', slug: `kt5-auto-${skillA.slice(0, 8)}`, description: 'v1 desc', prompt: 'v1 prompt body', visibility: 'tenant' })
  })

  it('§21-1/2: owner 编辑成功;non-owner(同租户)编辑被拒', async () => {
    const owner = await ctxFor(TA, UA)
    const nonOwner = await ctxFor(TA, UB)
    // 找到 skill id
    const found = await skillRepository.findById(owner, (await queryOne<{ id: string }>(`SELECT id FROM t_dsh_skills WHERE creator_id = ?`, [UA]))!.id)
    assert.ok(found)
    // owner 编辑成功(update 内部 owner-scoped)
    const ok = await skillService.update(owner, found.id, { description: 'edited desc' })
    assert.equal(ok, true)
    // non-owner 同租户编辑 → update 的 WHERE creator_id 不匹配 → false(路由层 400)
    const r2 = await skillService.update(await ctxFor(TA, UB), found.id, { description: 'hijack' })
    assert.equal(r2, false)
    // 恢复描述
    await skillService.update(owner, found.id, { description: 'v1 desc' })
  })

  it('§21-3: 跨租户编辑被拒(not-found 语义)', async () => {
    const foreign = await ctxFor(TB, U2)
    const owner = await ctxFor(TA, UA)
    const found = await skillRepository.findById(owner, (await queryOne<{ id: string }>(`SELECT id FROM t_dsh_skills WHERE creator_id = ?`, [UA]))!.id)
    assert.ok(found)
    // 跨租户:findById 谓词过滤 → undefined → not-found
    const missing = await skillRepository.findById(foreign, found.id)
    assert.equal(missing, undefined)
  })

  it('§21-4/5: owner 正文编辑 → 新版本 + latest_version 递增', async () => {
    const owner = await ctxFor(TA, UA)
    const skillId = (await queryOne<{ id: string }>(`SELECT id FROM t_dsh_skills WHERE creator_id = ?`, [UA]))!.id
    const before = (await queryOne<{ latest_version: string }>(`SELECT latest_version FROM t_dsh_skills WHERE id = ?`, [skillId]))!.latest_version
    const r = await skillService.saveAuthorEdit(owner, skillId, { prompt: 'v2 prompt body', tools: undefined })
    assert.equal(r.ok, true)
    const after = (await queryOne<{ latest_version: string }>(`SELECT latest_version FROM t_dsh_skills WHERE id = ?`, [skillId]))!.latest_version
    assert.equal(after, r.version)
    assert.notEqual(after, before)
    // 版本行存在
    const ver = await queryOne<{ version: string }>(`SELECT version FROM t_dsh_skill_versions WHERE skill_id = ? AND version = ?`, [skillId, r.version])
    assert.ok(ver, `version row ${r.version} missing`)
  })

  it('§21-6: 第二次编辑 → 版本继续递增,不覆盖', async () => {
    const owner = await ctxFor(TA, UA)
    const skillId = (await queryOne<{ id: string }>(`SELECT id FROM t_dsh_skills WHERE creator_id = ?`, [UA]))!.id
    const r1 = await skillService.saveAuthorEdit(owner, skillId, { prompt: 'v3 prompt body' })
    const versions = await skillRepository.listVersions(owner, skillId)
    const distinct = new Set(versions.map((v) => v.version))
    assert.equal(distinct.size, versions.length, '版本号重复')
    assert.ok(r1.version !== undefined)
  })

  it('§21-7: 版本历史可读(owner)', async () => {
    const owner = await ctxFor(TA, UA)
    const history = await skillService.listVersions(owner, (await queryOne<{ id: string }>(`SELECT id FROM t_dsh_skills WHERE creator_id = ?`, [UA]))!.id)
    assert.ok(history.length >= 2)
    assert.ok(history[0]!.createdAt !== undefined)
  })

  it('§21-8: publish 回归(published → 安装可用)', async () => {
    const owner = await ctxFor(TA, UA)
    const skillId = (await queryOne<{ id: string }>(`SELECT id FROM t_dsh_skills WHERE creator_id = ?`, [UA]))!.id
    assert.equal(await skillService.publish(owner, skillId), true)
    const installed = await skillRepository.install(owner, skillId)
    assert.equal(installed, true)
    const inst = await queryOne<{ version: string }>(`SELECT version FROM t_dsh_skill_installations WHERE skill_id = ? AND user_id = ?`, [skillId, UA])
    assert.equal(inst!.version, (await queryOne<{ latest_version: string }>(`SELECT latest_version FROM t_dsh_skills WHERE id = ?`, [skillId]))!.latest_version)
  })

  it('§21-10: unpublish 回归(draft;投影不含未发布)', async () => {
    const owner = await ctxFor(TA, UA)
    const skillId = (await queryOne<{ id: string }>(`SELECT id FROM t_dsh_skills WHERE creator_id = ?`, [UA]))!.id
    assert.equal(await skillService.unpublish(owner, skillId), true)
    const proj = await skillRepository.listProjectableInstalled(UA)
    assert.ok(!proj.some((p) => p.id === skillId), 'draft skill 不得进入投影')
  })

  it('§21-9/§14: re-publish 后安装版本跟随 latest(FOLLOW_LATEST)', async () => {
    const owner = await ctxFor(TA, UA)
    const skillId = (await queryOne<{ id: string }>(`SELECT id FROM t_dsh_skills WHERE creator_id = ?`, [UA]))!.id
    assert.equal(await skillService.publish(owner, skillId), true)
    const inst = await queryOne<{ version: string }>(`SELECT version FROM t_dsh_skill_installations WHERE skill_id = ? AND user_id = ?`, [skillId, UA])
    assert.equal(inst!.version, (await queryOne<{ latest_version: string }>(`SELECT latest_version FROM t_dsh_skills WHERE id = ?`, [skillId]))!.latest_version)
  })

  it('§21-12: 投影 body = 当前 prompt(FOLLOW_LATEST 实证)', async () => {
    const proj = await skillRepository.listProjectableInstalled(UA)
    const skillId = (await queryOne<{ id: string }>(`SELECT id FROM t_dsh_skills WHERE creator_id = ?`, [UA]))!.id
    const target = proj.find((p) => p.id === skillId)
    assert.ok(target)
    assert.ok(target!.prompt.includes('v3'), `投影正文应为最新编辑内容,实际:${target!.prompt.slice(0, 60)}`)
  })

  it('§21-11: 非 owner 编辑 → not-found(404 语义)', async () => {
    const other = await ctxFor(TA, UB)
    const skillId = (await queryOne<{ id: string }>(`SELECT id FROM t_dsh_skills WHERE creator_id = ?`, [UA]))!.id
    await assert.rejects(
      skillService.saveAuthorEdit(other, skillId, { prompt: 'hijack' }),
      /not-found/,
    )
  })

  after(async () => {
    await execute(`DELETE FROM t_dsh_skill_installations WHERE skill_id IN (SELECT id FROM t_dsh_skills WHERE creator_id = ?)`, [UA]).catch(() => undefined)
    await execute(`DELETE FROM t_dsh_skill_versions WHERE skill_id IN (SELECT id FROM t_dsh_skills WHERE creator_id = ?)`, [UA]).catch(() => undefined)
    await execute(`DELETE FROM t_dsh_skills WHERE creator_id = ?`, [UA]).catch(() => undefined)
    await execute(`DELETE FROM t_dsh_knowledge_bases WHERE id = ?`, [kbA]).catch(() => undefined)
    await execute(`DELETE FROM t_dsh_users WHERE id IN (?, ?, ?)`, [UA, UB, U2]).catch(() => undefined)
    await execute(`DELETE FROM t_dsh_tenants WHERE id IN (?, ?)`, [TA, TB]).catch(() => undefined)
    await pool.end()
  })
})
