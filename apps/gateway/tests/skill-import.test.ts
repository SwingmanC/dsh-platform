/**
 * SKILL-V1.3 集成单测:单个 SKILL.md Import + Preflight(真实 MySQL,自建 fixture,结束清理)。
 * 前置:MySQL 已运行。复用 V1.2 parseSkillMd;preflight 先于任何 DB 写入。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import { execute, queryOne, queryMany, pool } from '../src/db.js'
import { closeAuditWriter } from '../src/repositories/audit-repository.js'
import { skillRepository } from '../src/repositories/skill-repository.js'
import { skillService } from '../src/services/skill-service.js'
import { parseSkillMd, serializeSkillMd } from '../src/skill-format.js'
import type { TenantContext } from '@dsh-platform/shared'

const TA = randomUUID()
const TB = randomUUID()
const UA = randomUUID()   // owner(tenant A)
const UB = randomUUID()   // tenant A 另一用户(非 owner)
const U2 = randomUUID()   // tenant B 用户

function ctxFor(tenantId: string, userId: string): TenantContext {
  return { tenantId, userId, role: 'member', requestId: '', platformSessionId: '', deviceId: '' }
}

const VALID_MD = [
  '---',
  'name: imported-skill-a',
  'description: An imported skill',
  'whenToUse: Use when testing import',
  'disable-model-invocation: true',
  'user-invocable: false',
  '---',
  '',
  'You are a helpful test skill.',
  '',
].join('\n')

async function skillCount(userId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM t_dsh_skills WHERE creator_id = ?`, [userId])
  return row?.n ?? 0
}

describe('SKILL-V1.3 SKILL.md Import + Preflight', () => {
  it('fixtures: 租户/用户', async () => {
    const settings = JSON.stringify({})
    await execute(`INSERT INTO t_dsh_tenants (id, slug, name, settings) VALUES (?, ?, ?, ?)`, [TA, `sk13-ta-${TA.slice(0, 8)}`, 'SK13 A', settings])
    await execute(`INSERT INTO t_dsh_tenants (id, slug, name, settings) VALUES (?, ?, ?, ?)`, [TB, `sk13-tb-${TB.slice(0, 8)}`, 'SK13 B', settings])
    await execute(`INSERT INTO t_dsh_users (id, tenant_id, email, display_name, password_hash, role) VALUES (?, ?, ?, ?, 'x', 'member')`, [UA, TA, `sk13-ua@t`, 'SK13 UA'])
    await execute(`INSERT INTO t_dsh_users (id, tenant_id, email, display_name, password_hash, role) VALUES (?, ?, ?, ?, 'x', 'member')`, [UB, TA, `sk13-ub@t`, 'SK13 UB'])
    await execute(`INSERT INTO t_dsh_users (id, tenant_id, email, display_name, password_hash, role) VALUES (?, ?, ?, ?, 'x', 'member')`, [U2, TB, `sk13-u2@t`, 'SK13 U2'])
  })

  it('§30-1/2/3/4: valid import → draft;canonical 字段与 invocation flags 正确映射', async () => {
    const owner = ctxFor(TA, UA)
    const skill = await skillService.importSkillMd(owner, 'SKILL.md', VALID_MD)
    assert.equal(skill.status, 'draft')
    assert.equal(skill.name, 'imported-skill-a')
    assert.equal(skill.description, 'An imported skill')
    assert.equal(skill.whenToUse, 'Use when testing import')
    assert.equal(skill.modelInvocable, false)
    assert.equal(skill.userInvocable, false)
    assert.ok(skill.prompt.includes('helpful test skill'))
    assert.equal(skill.sourceType, 'upload')
  })

  it('§29: source_type 记录现有枚举 upload(schema 未修改)', async () => {
    const row = await queryOne<{ source_type: string }>(`SELECT source_type FROM t_dsh_skills WHERE creator_id = ?`, [UA])
    assert.equal(row?.source_type, 'upload')
  })

  it('§30-12: creator = 当前用户(身份来自 ctx,不可由请求提供)', async () => {
    const row = await queryOne<{ creator_id: string; tenant_id: string }>(`SELECT creator_id, tenant_id FROM t_dsh_skills WHERE name = 'imported-skill-a'`)
    assert.equal(row?.creator_id, UA)
    assert.equal(row?.tenant_id, TA)
  })

  it('§30-5/6/7/8: missing name/description、missing body、malformed frontmatter 拒绝', async () => {
    const owner = ctxFor(TA, UA)
    await assert.rejects(skillService.importSkillMd(owner, 'SKILL.md', '---\ndescription: d\n---\nbody'), /missing-name/)
    await assert.rejects(skillService.importSkillMd(owner, 'SKILL.md', '---\nname: x-a\n---\nbody'), /missing-description/)
    await assert.rejects(skillService.importSkillMd(owner, 'SKILL.md', '---\nname: x-a\ndescription: d\n---\n'), /missing-body/)
    await assert.rejects(skillService.importSkillMd(owner, 'SKILL.md', 'no frontmatter at all'), /malformed-frontmatter/)
    await assert.rejects(skillService.importSkillMd(owner, 'SKILL.md', '---\nname: X A\ndescription: d\n---\nbody'), /invalid-name/)
    await assert.rejects(skillService.importSkillMd(owner, 'SKILL.txt', '---\nname: x-a\ndescription: d\n---\nbody'), /invalid-skill-file/)
  })

  it('§30-9: 超限文件拒绝(复用 SKILL_MD_MAX_CHARS)', async () => {
    const owner = ctxFor(TA, UA)
    const oversized = `---\nname: big-a\ndescription: d\n---\n${'a'.repeat(512 * 1024)}`
    await assert.rejects(skillService.importSkillMd(owner, 'SKILL.md', oversized), /skill-file-too-large/)
  })

  it('§30-10/§11/§12: 同名重复拒绝;不覆盖不 rename', async () => {
    const owner = ctxFor(TA, UA)
    await assert.rejects(skillService.importSkillMd(owner, 'SKILL.md', VALID_MD), /duplicate-skill-name/)
    const rows = await queryMany<{ id: string }>(`SELECT id FROM t_dsh_skills WHERE name = 'imported-skill-a'`)
    assert.equal(rows.length, 1, '重复导入不得产生第二行')
  })

  it('§30-11/§4/§18: 失败 preflight 后无任何 DB 写入(无 Skill/Version/Installation)', async () => {
    const owner = ctxFor(TA, UA)
    const before = await skillCount(UA)
    const versBefore = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM t_dsh_skill_versions v JOIN t_dsh_skills s ON s.id = v.skill_id WHERE s.creator_id = ?`, [UA])
    await assert.rejects(skillService.importSkillMd(owner, 'SKILL.md', '---\nname: bad-a\n---\nbody'), /missing-description/)
    await assert.rejects(skillService.importSkillMd(owner, 'SKILL.md', VALID_MD), /duplicate-skill-name/)
    const after = await skillCount(UA)
    assert.equal(after, before, '失败 import 不得产生 Skill')
    const versAfter = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM t_dsh_skill_versions v JOIN t_dsh_skills s ON s.id = v.skill_id WHERE s.creator_id = ?`, [UA])
    assert.equal(versAfter?.n, versBefore?.n, '失败 import 不得产生 Version')
    const insts = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM t_dsh_skill_installations i JOIN t_dsh_skills s ON s.id = i.skill_id WHERE s.creator_id = ?`, [UA])
    assert.equal(insts?.n, 0, '失败 import 不得产生 Installation')
  })

  it('§19: preflight API 返回预览且无 DB 写入', async () => {
    const owner = ctxFor(TA, UA)
    const before = await skillCount(UA)
    const p1 = await skillService.preflightImport(owner, 'SKILL.md', VALID_MD)
    assert.equal(p1.valid, false)
    assert.ok(p1.errors.includes('duplicate-skill-name'))
    const fresh = VALID_MD.replace('imported-skill-a', 'preflight-only-a')
    const p2 = await skillService.preflightImport(owner, 'SKILL.md', fresh)
    assert.equal(p2.valid, true)
    assert.equal(p2.name, 'preflight-only-a')
    assert.equal(p2.modelInvocable, false)
    assert.equal(p2.userInvocable, false)
    assert.equal(await skillCount(UA), before, 'preflight 不得写 DB')
  })

  it('§30-13/14: 跨用户编辑拒绝;跨租户隔离(not-found)', async () => {
    const skillId = (await queryOne<{ id: string }>(`SELECT id FROM t_dsh_skills WHERE name = 'imported-skill-a'`))!.id
    await assert.rejects(skillService.saveAuthorEdit(ctxFor(TA, UB), skillId, { prompt: 'hijack' }), /not-found/)
    const foreign = await skillRepository.findById(ctxFor(TB, U2), skillId)
    assert.equal(foreign, undefined)
  })

  it('§30-15/§27: draft 不进入投影', async () => {
    const skillId = (await queryOne<{ id: string }>(`SELECT id FROM t_dsh_skills WHERE name = 'imported-skill-a'`))!.id
    const proj = await skillRepository.listProjectableInstalled(UA)
    assert.ok(!proj.some((p) => p.id === skillId), 'draft skill 不得进入投影')
  })

  it('§30-16/17/§28: imported skill 可 publish → install → 进入投影', async () => {
    const owner = ctxFor(TA, UA)
    const skillId = (await queryOne<{ id: string }>(`SELECT id FROM t_dsh_skills WHERE name = 'imported-skill-a'`))!.id
    assert.equal(await skillService.publish(owner, skillId), true)
    assert.equal(await skillService.install(owner, skillId), true)
    const proj = await skillRepository.listProjectableInstalled(UA)
    const entry = proj.find((p) => p.id === skillId)
    assert.ok(entry, 'published+installed 后应进入投影')
    assert.equal(entry!.modelInvocable, false)
    assert.equal(entry!.userInvocable, false)
  })

  it('§30-18: V1.1 edit/version 回归(imported skill 编辑 → 版本推进)', async () => {
    const owner = ctxFor(TA, UA)
    const skillId = (await queryOne<{ id: string }>(`SELECT id FROM t_dsh_skills WHERE name = 'imported-skill-a'`))!.id
    const r = await skillService.saveAuthorEdit(owner, skillId, { prompt: 'edited imported body', whenToUse: 'updated hint' })
    assert.equal(r.ok, true)
    assert.ok(r.version !== undefined)
    const ver = await queryOne<{ version: string }>(`SELECT version FROM t_dsh_skill_versions WHERE skill_id = ? AND version = ?`, [skillId, r.version])
    assert.ok(ver, '版本行存在')
  })

  it('§30-19: V1.2 parser round-trip 回归(serialize∘parse 恒等)', async () => {
    const c1 = parseSkillMd(VALID_MD)
    const c2 = parseSkillMd(serializeSkillMd(c1))
    assert.deepEqual(c2, c1)
  })

  after(async () => {
    await execute(`DELETE FROM t_dsh_skill_installations WHERE skill_id IN (SELECT id FROM t_dsh_skills WHERE creator_id = ?)`, [UA]).catch(() => undefined)
    await execute(`DELETE FROM t_dsh_skill_versions WHERE skill_id IN (SELECT id FROM t_dsh_skills WHERE creator_id = ?)`, [UA]).catch(() => undefined)
    await execute(`DELETE FROM t_dsh_skills WHERE creator_id = ?`, [UA]).catch(() => undefined)
    await execute(`DELETE FROM t_dsh_users WHERE id IN (?, ?, ?)`, [UA, UB, U2]).catch(() => undefined)
    await execute(`DELETE FROM t_dsh_tenants WHERE id IN (?, ?)`, [TA, TB]).catch(() => undefined)
    await closeAuditWriter().catch(() => undefined)
    await pool.end()
  })
})
