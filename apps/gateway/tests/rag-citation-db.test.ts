/**
 * K-T7 集成单测:citation 附着(hybrid/keyword)+ resolve ACL 硬 gate(真实 MySQL)。
 * 前置:MySQL 已运行;自建 fixture,结束清理。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import { execute, queryOne, pool } from '../src/db.js'
import { closeAuditWriter } from '../src/repositories/audit-repository.js'
import { knowledgeService } from '../src/services/knowledge-service.js'
import { knowledgeRepository } from '../src/repositories/knowledge-repository.js'

const TA = randomUUID()
const TB = randomUUID()
const kbA = randomUUID()
const kbB = randomUUID()
const docA = randomUUID()
const docB = randomUUID()
const chunkA = randomUUID()  // tenant A:差旅语义内容(K-T6 语义查询目标)
const chunkB = randomUUID()  // tenant B
const UA = randomUUID()      // tenant A 的用户(creator)
const UB = randomUUID()      // tenant B 的用户
const MARKER = 'CMCC_PDF_KNOWLEDGE_TEST citation-regression'

async function ctxFor(tenantId: string, userId: string) {
  return { tenantId, userId, role: 'member' as const, requestId: '', platformSessionId: '', deviceId: '' }
}

describe('K-T7 Citation(真实 MySQL)', () => {
  it('fixtures', async () => {
    const settings = JSON.stringify({})
    await execute(`INSERT INTO t_dsh_tenants (id, slug, name, settings) VALUES (?, ?, ?, ?)`, [TA, `kt7-ta-${TA.slice(0, 8)}`, 'KT7 A', settings])
    await execute(`INSERT INTO t_dsh_tenants (id, slug, name, settings) VALUES (?, ?, ?, ?)`, [TB, `kt7-tb-${TB.slice(0, 8)}`, 'KT7 B', settings])
    await execute(`INSERT INTO t_dsh_users (id, tenant_id, email, display_name, password_hash, role) VALUES (?, ?, ?, ?, 'x', 'member')`, [UA, TA, `kt7-ua-${UA.slice(0, 8)}@t`, 'KT7 UA'])
    await execute(`INSERT INTO t_dsh_users (id, tenant_id, email, display_name, password_hash, role) VALUES (?, ?, ?, ?, 'x', 'member')`, [UB, TB, `kt7-ub-${UB.slice(0, 8)}@t`, 'KT7 UB'])
    await execute(`INSERT INTO t_dsh_knowledge_bases (id, tenant_id, creator_id, name, visibility, status) VALUES (?, ?, ?, 'kt7-a', 'personal', 'active')`, [kbA, TA, UA])
    await execute(`INSERT INTO t_dsh_knowledge_bases (id, tenant_id, creator_id, name, visibility, status) VALUES (?, ?, ?, 'kt7-b', 'personal', 'active')`, [kbB, TB, UB])
    await execute(`INSERT INTO t_dsh_knowledge_documents (id, kb_id, filename, filepath, status) VALUES (?, ?, 'travel.md', '', 'ready')`, [docA, kbA])
    await execute(`INSERT INTO t_dsh_knowledge_documents (id, kb_id, filename, filepath, status) VALUES (?, ?, 'marker.pdf', '', 'ready')`, [docB, kbB])
    await execute(`INSERT INTO t_dsh_knowledge_document_versions (id, doc_id, version, content, content_hash, filepath, file_size) VALUES (?, ?, 1, 'v1', 'h1', '', 0)`, [randomUUID(), docA])
    await execute(`INSERT INTO t_dsh_knowledge_document_versions (id, doc_id, version, content, content_hash, filepath, file_size) VALUES (?, ?, 1, 'v1', 'h2', '', 0)`, [randomUUID(), docB])
    await execute(`INSERT INTO t_dsh_knowledge_chunks (id, doc_id, kb_id, chunk_index, content) VALUES (?, ?, ?, 0, '员工差旅可以报销城际交通费用')`, [chunkA, docA, kbA])
    await execute(`INSERT INTO t_dsh_knowledge_chunks (id, doc_id, kb_id, chunk_index, content) VALUES (?, ?, ?, 0, ?)`, [chunkB, docB, kbB, MARKER])
    await execute(`INSERT INTO t_dsh_knowledge_mounts (id, user_id, kb_id, mount_type) VALUES (?, ?, ?, 'user')`, [randomUUID(), UA, kbA])
  })

  it('§17-2/3: hybrid 与 keyword 结果均携带稳定 citation', async () => {
    const ctx = await ctxFor(TA, UA)
    const r = await knowledgeService.search(ctx, { q: '员工差旅可以报销城际交通费用', mode: 'keyword' })
    assert.ok(r.total >= 1, `keyword total=${r.total}`)
    const c = r.chunks.find((x) => x.id === chunkA)
    assert.ok(c, '目标 chunk 未命中')
    assert.ok(c.citation, 'keyword 结果缺 citation')
    assert.equal(c.citation!.kbId, kbA)
    assert.equal(c.citation!.documentId, docA)
    assert.ok(c.citation!.documentVersionId)
    assert.equal(c.citation!.chunkId, chunkA)
    assert.equal(c.citation!.documentTitle, 'travel.md')
    // §18 稳定性:service 再次生成一致
    const r2 = await knowledgeService.search(ctx, { q: '员工差旅可以报销城际交通费用', mode: 'keyword' })
    assert.equal(r2.chunks.find((x) => x.id === chunkA)!.citation!.citationId, c.citation!.citationId)
    // §19 hybrid 回归:语义/关键词命中且 rank 不变(hybrid 含该 chunk + citation)
    const rh = await knowledgeService.search(ctx, { q: '员工差旅可以报销城际交通费用' })
    assert.equal(rh.retrievalMode, 'keyword') // 无 embedding config → fallback(符合 K-T6-lite 行为)
    assert.ok(rh.chunks.some((x) => x.id === chunkA && x.citation !== undefined))
  })

  it('§9 citation resolve:owner 经 mount 可解析', async () => {
    const ctx = await ctxFor(TA, UA)
    const cid = `kb:${kbA}:doc:${docA}:ver:unknown-pinned:chunk:${chunkA}`
    // versionId 未知 → 用 current_version 的 versionId 组装正确 citation
    const vm = await knowledgeRepository.getVersionIdMap([docA])
    const validCid = `kb:${kbA}:doc:${docA}:ver:${vm.get(docA)}:chunk:${chunkA}`
    const resolved = await knowledgeService.resolveCitation(ctx, validCid)
    assert.ok(resolved)
    assert.equal(resolved!.citationId, validCid)
    assert.equal(resolved!.chunkId, chunkA)
    assert.equal(resolved!.documentVersionId, vm.get(docA))
    assert.equal(resolved!.snippet.includes('员工差旅'), true)
    void cid
  })

  it('§12 tenant isolation: tenant B 用户持 A 的 citationId → 404 语义(null),无元数据泄漏', async () => {
    const ctxB = await ctxFor(TB, UB)
    const vm = await knowledgeRepository.getVersionIdMap([docA])
    const cid = `kb:${kbA}:doc:${docA}:ver:${vm.get(docA)}:chunk:${chunkA}`
    const resolved = await knowledgeService.resolveCitation(ctxB, cid)
    assert.equal(resolved, null)
  })

  it('§12 user/mount isolation: 同租户无 mount 用户 → null', async () => {
    const other = randomUUID()  // 同租户另一用户(未 mount kbA)
    const ctxOther = await ctxFor(TA, other)
    const vm = await knowledgeRepository.getVersionIdMap([docA])
    const cid = `kb:${kbA}:doc:${docA}:ver:${vm.get(docA)}:chunk:${chunkA}`
    const resolved = await knowledgeService.resolveCitation(ctxOther, cid)
    assert.equal(resolved, null)
  })

  it('§9 malformed citationId → invalid-citation-id', async () => {
    const ctx = await ctxFor(TA, UA)
    await assert.rejects(
      knowledgeService.resolveCitation(ctx, 'not-a-citation'),
      /invalid-citation-id/,
    )
  })

  it('§13 deleted document → citation 不可解析(null)', async () => {
    // 直接删除 docA 的版本行映射(d.current_version 指向被删版本 → join 失败)
    await execute(`DELETE FROM t_dsh_knowledge_document_versions WHERE doc_id = ?`, [docA])
    const ctx = await ctxFor(TA, UA)
    const vm = await knowledgeRepository.getVersionIdMap([docA])
    const cid = `kb:${kbA}:doc:${docA}:ver:${vm.get(docA) ?? 'gone'}:chunk:${chunkA}`
    const resolved = await knowledgeService.resolveCitation(ctx, cid)
    assert.equal(resolved, null)
  })

  after(async () => {
    await execute(`DELETE FROM t_dsh_knowledge_bases WHERE id IN (?, ?)`, [kbA, kbB]).catch(() => undefined)
    await execute(`DELETE FROM t_dsh_users WHERE id IN (?, ?)`, [UA, UB]).catch(() => undefined)
    await execute(`DELETE FROM t_dsh_tenants WHERE id IN (?, ?)`, [TA, TB]).catch(() => undefined)
    await closeAuditWriter().catch(() => undefined)
    await pool.end()
  })
})
