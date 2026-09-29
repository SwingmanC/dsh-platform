/**
 * K-T6-lite 集成单测:MySQLBlobVectorStore(真实 MySQL,自建 fixture,结束清理)。
 *
 * 覆盖 §25:upsert / scoped search / deleteByDocument / tenant isolation(§22 硬 gate)/
 *          missing embeddings(§23)。
 * 前置:MySQL 已运行(遵循 §28 — 不启动任何服务,仅使用现有环境)。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import { execute, queryOne, pool } from '../src/db.js'
import { MySQLBlobVectorStore } from '../src/rag/mysql-blob-vector-store.js'
import { decodeFloat32Vector } from '../src/rag/vector-store.js'

const store = new MySQLBlobVectorStore()
const TA = randomUUID()  // tenant A
const TB = randomUUID()  // tenant B
const kbA = randomUUID()
const kbB = randomUUID()
const docA = randomUUID()
const docB = randomUUID()
const chunkA = randomUUID()  // tenant A:差旅语义文档
const chunkB = randomUUID()  // tenant B:与 query 完美匹配(cosine=1.0)

const seedVector = [1, 0, 0, 0]

describe('MySQLBlobVectorStore(K-T6-lite)', () => {
  it('fixtures: 租户/KB/文档/chunk 就位', async () => {
    const user = await queryOne<{ id: string }>(`SELECT id FROM t_dsh_users ORDER BY created_at LIMIT 1`)
    assert.ok(user, '需要至少一个已存在的用户(creator_id FK)')
    await execute(`INSERT INTO t_dsh_tenants (id, slug, name, settings) VALUES (?, ?, ?, JSON_OBJECT())`, [TA, `kt6-ta-${TA.slice(0, 8)}`, 'KT6 Tenant A'])
    await execute(`INSERT INTO t_dsh_tenants (id, slug, name, settings) VALUES (?, ?, ?, JSON_OBJECT())`, [TB, `kt6-tb-${TB.slice(0, 8)}`, 'KT6 Tenant B'])
    await execute(`INSERT INTO t_dsh_knowledge_bases (id, tenant_id, creator_id, name, visibility, status) VALUES (?, ?, ?, 'kt6-a', 'personal', 'active')`, [kbA, TA, user.id])
    await execute(`INSERT INTO t_dsh_knowledge_bases (id, tenant_id, creator_id, name, visibility, status) VALUES (?, ?, ?, 'kt6-b', 'personal', 'active')`, [kbB, TB, user.id])
    await execute(`INSERT INTO t_dsh_knowledge_documents (id, kb_id, filename, filepath, status) VALUES (?, ?, 'a.md', '', 'ready')`, [docA, kbA])
    await execute(`INSERT INTO t_dsh_knowledge_documents (id, kb_id, filename, filepath, status) VALUES (?, ?, 'b.md', '', 'ready')`, [docB, kbB])
    await execute(`INSERT INTO t_dsh_knowledge_chunks (id, doc_id, kb_id, chunk_index, content) VALUES (?, ?, ?, 0, '员工差旅可以报销城际交通费用')`, [chunkA, docA, kbA])
    await execute(`INSERT INTO t_dsh_knowledge_chunks (id, doc_id, kb_id, chunk_index, content) VALUES (?, ?, ?, 0, 'PERFECT_QUERY_MATCH')`, [chunkB, docB, kbB])
  })

  it('upsert: 正确租户写入成功(Float32 BLOB round-trip)', async () => {
    await store.upsert([{ chunkId: chunkA, docId: docA, kbId: kbA, tenantId: TA, embedding: [0.5, 0.5, 0.5, 0] }])
    const row = await queryOne<{ embedding: Buffer }>(`SELECT embedding FROM t_dsh_knowledge_chunks WHERE id = ?`, [chunkA])
    assert.deepEqual(decodeFloat32Vector(row!.embedding as Buffer), [0.5, 0.5, 0.5, 0])
  })

  it('upsert: 跨租户写入被拒绝(chunk-not-found-or-forbidden)', async () => {
    // tenant A 尝试写 tenant B 的 chunk → 必须失败(hard gate 前置)
    await assert.rejects(
      store.upsert([{ chunkId: chunkB, docId: docB, kbId: kbB, tenantId: TA, embedding: [9, 9, 9, 9] }]),
      /chunk-not-found-or-forbidden/,
    )
    const row = await queryOne<{ embedding: Buffer | null }>(`SELECT embedding FROM t_dsh_knowledge_chunks WHERE id = ?`, [chunkB])
    assert.equal(row!.embedding, null)
  })

  it('§22 ACL 硬 gate: query=tenant B 完美匹配向量,scope 只含 tenant A chunk → B 永不出现', async () => {
    // B chunk 的向量 = [1,0,0,0](与 query cosine = 1.0 的"完美匹配")
    await store.upsert([{ chunkId: chunkB, docId: docB, kbId: kbB, tenantId: TB, embedding: seedVector }])
    const query = [1, 0, 0, 0]
    // tenant A 用户经 Knowledge Service 计算 allowed scope = 仅 chunkA
    const results = await store.search(query, { tenantId: TA, allowedChunkIds: [chunkA] }, 20)
    assert.ok(!results.some((r) => r.chunkId === chunkB), 'tenant B chunk 必须绝不出现(K-T6 FAIL_SECURITY 红线)')
    assert.ok(results.every((r) => r.chunkId === chunkA))
  })

  it('§23 missing embeddings: embedding 为 NULL 的 chunk 不参与 vector,但行仍在', async () => {
    await store.deleteByDocument(TA, docA)
    const row = await queryOne<{ embedding: Buffer | null }>(`SELECT embedding FROM t_dsh_knowledge_chunks WHERE id = ?`, [chunkA])
    assert.equal(row!.embedding, null)
    const results = await store.search([0.5, 0.5, 0.5, 0], { tenantId: TA, allowedChunkIds: [chunkA] }, 20)
    assert.equal(results.length, 0)
  })

  after(async () => {
    // 清理 fixture(kb 级联删除 docs/chunks;再删租户)
    await execute(`DELETE FROM t_dsh_knowledge_bases WHERE id IN (?, ?)`, [kbA, kbB]).catch(() => undefined)
    await execute(`DELETE FROM t_dsh_tenants WHERE id IN (?, ?)`, [TA, TB]).catch(() => undefined)
    await pool.end()
  })
})
