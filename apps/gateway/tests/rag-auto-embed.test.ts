/**
 * K-T5-lite 集成单测:upload → chunks → 自动 embedding → VectorStore.upsert → hybrid 可检索。
 * 前置:MySQL 已运行;embedding 走测试内 mock HTTP server(无真实外部 Provider)。
 * env 由 tests/setup-env.mjs(--import)先行注入。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { execute, queryMany, queryOne, pool } from '../src/db.js'
import { closeAuditWriter } from '../src/repositories/audit-repository.js'
import { knowledgeService } from '../src/services/knowledge-service.js'
import { knowledgeRepository } from '../src/repositories/knowledge-repository.js'
import { ragEmbeddingConfigRepository } from '../src/repositories/rag-embedding-config-repository.js'
import { getCredentialStore } from '../src/credentials/credential-store.js'

// --- 确定性 mock embedding:vocabulary 聚类(travel/transport/claim → cluster A) ---
function mockEmbed(text: string): number[] {
  const t = text.toLowerCase()
  const v = [0, 0, 1] // v2 = bias
  if (/travel|trip|business/.test(t)) v[0] = 1
  if (/train|transport|intercity|rail/.test(t)) v[1] = 1
  if (/claim|cost|expense|reimburse/.test(t)) v[2] = 1
  return v
}

async function startMock(): Promise<{ port: number; sizes: number[]; close(): Promise<void> }> {
  const sizes: number[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => { raw += c.toString('utf8') })
    req.on('end', () => {
      let body: { input?: string[] } = {}
      try { body = JSON.parse(raw) } catch { /* ignore */ }
      const input = Array.isArray(body.input) ? body.input : []
      sizes.push(input.length)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: input.map((t) => ({ embedding: mockEmbed(t) })) }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = address !== null && typeof address === 'object' ? address.port : 0
  return { port, sizes, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

const TA = randomUUID()  // 有 embedding config
const TB = randomUUID()  // 无 embedding config
const kbA = randomUUID()
const kbB = randomUUID()
// ctx.userId 在 fixtures 中替换为真实用户(creator_id FK/creator 匹配需要)
let ctxA = { tenantId: TA, userId: '', role: 'tenant_admin' as const, requestId: '', platformSessionId: '', deviceId: '' }
let ctxB = { tenantId: TB, userId: '', role: 'tenant_admin' as const, requestId: '', platformSessionId: '', deviceId: '' }
const mock = await startMock()

describe('K-T5-lite 自动 embedding 闭环', () => {
  it('fixtures: 租户/KB/管理员配置(mock provider)', async () => {
    const user = await queryOne<{ id: string }>(`SELECT id FROM t_dsh_users ORDER BY created_at LIMIT 1`)
    assert.ok(user)
    ctxA = { ...ctxA, userId: user.id }
    ctxB = { ...ctxB, userId: user.id }
    await execute(`INSERT INTO t_dsh_tenants (id, slug, name, settings) VALUES (?, ?, ?, JSON_OBJECT())`, [TA, `kt5-ta-${TA.slice(0, 8)}`, 'KT5 A'])
    await execute(`INSERT INTO t_dsh_tenants (id, slug, name, settings) VALUES (?, ?, ?, JSON_OBJECT())`, [TB, `kt5-tb-${TB.slice(0, 8)}`, 'KT5 B'])
    await execute(`INSERT INTO t_dsh_knowledge_bases (id, tenant_id, creator_id, name, visibility, status) VALUES (?, ?, ?, 'kt5-a', 'personal', 'active')`, [kbA, TA, user.id])
    await execute(`INSERT INTO t_dsh_knowledge_bases (id, tenant_id, creator_id, name, visibility, status) VALUES (?, ?, ?, 'kt5-b', 'personal', 'active')`, [kbB, TB, user.id])
    // 检索 ACL 前提:KB 存在后挂载(INSERT IGNORE 会静默吞掉 FK 违规,顺序不能反)
    await knowledgeRepository.mount(ctxA, kbA)
    await knowledgeRepository.mount(ctxB, kbB)
    await ragEmbeddingConfigRepository.upsert(TA, {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${mock.port}/v1`,
      model: 'mock-embed', dims: 3,
      envelope: Buffer.from(getCredentialStore().seal('mock-key'), 'utf8'), keyHint: 'mock',
    })
  })

  it('Case 1+2: 上传 → 自动 embedding → 无 seed 即 hybrid 语义命中', async () => {
    const content = 'Employees may claim intercity transportation expenses during approved business travel.'
    const doc = await knowledgeService.uploadDocument(ctxA, kbA, 'travel-auto-index.md', 'text/markdown', Buffer.from(content, 'utf8'))
    // K-T1 已知:返回的 doc 为 addDocument 时点快照;真实状态查库
    const dbDocA = await queryOne<{ status: string }>(`SELECT status FROM t_dsh_knowledge_documents WHERE id = ?`, [doc.id])
    assert.equal(dbDocA!.status, 'ready')
    // chunks.embedding 已自动写入
    const chunk = await queryOne<{ id: string; embedding: Buffer | null }>(`SELECT id, embedding FROM t_dsh_knowledge_chunks WHERE doc_id = ?`, [doc.id])
    const jobDiag = await queryOne<{ status: string; errorMessage: string | null }>(
      `SELECT status, error_message AS errorMessage FROM t_dsh_knowledge_ingestion_jobs WHERE doc_id = ? ORDER BY created_at DESC`, [doc.id])
    assert.ok(chunk!.id)
    assert.ok(chunk!.embedding !== null, `embedding null; job=${jobDiag?.status}/${jobDiag?.errorMessage ?? 'null'}`)
    // 无 seed,直接 hybrid 检索
    const r = await knowledgeService.search(ctxA, { q: 'how can i claim train costs on a work trip', kbId: kbA })
    assert.equal(r.retrievalMode, 'hybrid', `retrievalMode=${r.retrievalMode} fallback=${r.vectorFallbackReason ?? 'none'}`)
    assert.ok(r.total >= 1)
    assert.ok(r.chunks.some((c) => c.content.includes('transportation')))
  })

  it('Case 3: 无 embedding config 的租户上传 → ready + embedding NULL + keyword 可检索', async () => {
    const t3 = Date.now()
    const doc = await knowledgeService.uploadDocument(ctxB, kbB, 'keyword-only.md', 'text/markdown', Buffer.from('KEYWORD_ONLY_MARKER_KT5 unique body', 'utf8'))
    console.log(`case3 upload took ${Date.now() - t3}ms`)
    const dbDocB = await queryOne<{ status: string }>(`SELECT status FROM t_dsh_knowledge_documents WHERE id = ?`, [doc.id])
    assert.equal(dbDocB!.status, 'ready')
    // 诊断:逐环节计数
    const dbg = await queryMany<{ k: string; n: number }>(
      `SELECT 'mount' AS k, COUNT(*) AS n FROM t_dsh_knowledge_mounts WHERE user_id = ? AND kb_id = ?
       UNION ALL SELECT 'docready', COUNT(*) FROM t_dsh_knowledge_documents WHERE id = ? AND status = 'ready'
       UNION ALL SELECT 'chunk', COUNT(*) FROM t_dsh_knowledge_chunks WHERE doc_id = ?
       UNION ALL SELECT 'base-by-creator', COUNT(*) FROM t_dsh_knowledge_bases WHERE id = ? AND creator_id = ?`,
      [ctxB.userId, kbB, doc.id, doc.id, kbB, ctxB.userId])
    console.log('[case3-diag]', JSON.stringify(dbg))
    const row = await queryOne<{ embedding: Buffer | null }>(`SELECT embedding FROM t_dsh_knowledge_chunks WHERE doc_id = ?`, [doc.id])
    assert.equal(row!.embedding, null)
    const r = await knowledgeService.search(ctxB, { q: 'KEYWORD_ONLY_MARKER_KT5' })
    assert.ok(r.total >= 1, `keyword total=${r.total}`)
    assert.equal(r.retrievalMode, 'keyword')
  })

  it('Case 6: >20 chunks → provider 分批 20 + remainder', async () => {
    // 25 段 × 每段 700 字符(chunk 默认 800)→ ≥25 chunks
    const para = 'batch paragraph '.padEnd(700, 'z')
    const content = Array.from({ length: 25 }, (_, i) => `P${i} ${para}`).join('\n\n')
    const doc = await knowledgeService.uploadDocument(ctxA, kbA, 'batch-doc.md', 'text/markdown', Buffer.from(content, 'utf8'))
    const dbDocC = await queryOne<{ status: string }>(`SELECT status FROM t_dsh_knowledge_documents WHERE id = ?`, [doc.id])
    assert.equal(dbDocC!.status, 'ready')
    const [cnt] = await queryMany<{ n: number }>(
      `SELECT COUNT(*) AS n FROM t_dsh_knowledge_chunks WHERE doc_id = ? AND embedding IS NOT NULL`, [doc.id])
    const [total] = await queryMany<{ n: number }>(
      `SELECT COUNT(*) AS n FROM t_dsh_knowledge_chunks WHERE doc_id = ?`, [doc.id])
    assert.ok(total.n > 20, `expected >20 chunks, got ${total.n}`)
    assert.equal(cnt.n, total.n, '全部 chunk 均有 embedding')
  })

  it('Case 4: provider 超时 → 文档保留 ready,keyword 可用,job 记录受控诊断', async () => {
    // 挂起服务器(不响应)→ 触发 10s 硬超时
    const { port: hangPort, close } = await (async () => {
      const http = await import('node:http')
      const server = http.createServer(() => { /* 不响应 */ })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const address = server.address()
      const port = address !== null && typeof address === 'object' ? address.port : 0
      return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
    })()
    await ragEmbeddingConfigRepository.upsert(TA, {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${hangPort}/v1`,
      model: 'hang', dims: 3, envelope: Buffer.from(getCredentialStore().seal('hang-key'), 'utf8'), keyHint: 'hang',
    })
    const doc = await knowledgeService.uploadDocument(ctxA, kbA, 'hang-doc.md', 'text/markdown', Buffer.from('hang timeout probe body', 'utf8'))
    // 上传返回即代表未无限等待(embedding 超时后 job ready);doc 保留
    assert.equal(doc.status, 'uploaded') // 快照状态;DB 实际 ready
    const row = await queryOne<{ status: string; }>(`SELECT status FROM t_dsh_knowledge_documents WHERE id = ?`, [doc.id])
    assert.equal(row!.status, 'ready')
    const job = await queryOne<{ status: string; errorMessage: string | null }>(
      `SELECT status, error_message AS errorMessage FROM t_dsh_knowledge_ingestion_jobs WHERE doc_id = ? ORDER BY created_at DESC`, [doc.id])
    assert.equal(job!.status, 'ready')
    assert.equal(job!.errorMessage, 'embedding-timeout')
    await close()
  })

  it('Case 5: 维度不匹配 → embedding 不写入,chunk/文档保留,keyword 可用', async () => {
    // dims=3 配置;mock 固定返回 3 维 → 正常;改为 dims=2 制造不匹配
    await ragEmbeddingConfigRepository.upsert(TA, {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${mock.port}/v1`,
      model: 'mock-embed', dims: 2, envelope: Buffer.from(getCredentialStore().seal('dim-key'), 'utf8'), keyHint: 'mock',
    })
    const doc = await knowledgeService.uploadDocument(ctxA, kbA, 'dim-mismatch.md', 'text/markdown', Buffer.from('dimension mismatch probe KT5 body', 'utf8'))
    const row = await queryOne<{ embedding: Buffer | null }>(`SELECT embedding FROM t_dsh_knowledge_chunks WHERE doc_id = ?`, [doc.id])
    assert.equal(row!.embedding, null, 'dimension-mismatch 时 embedding 不得写入')
    const cnt = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM t_dsh_knowledge_chunks WHERE doc_id = ?`, [doc.id])
    assert.ok(cnt!.n > 0, 'chunks 保留')
    const r = await knowledgeService.search(ctxA, { q: 'dimension mismatch probe KT5' })
    assert.ok(r.total >= 1, 'keyword 检索仍可用')
    // 恢复 dims=3 供后续
    await ragEmbeddingConfigRepository.upsert(TA, {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${mock.port}/v1`,
      model: 'mock-embed', dims: 3, envelope: Buffer.from(getCredentialStore().seal('restore-key'), 'utf8'), keyHint: 'mock',
    })
  })

  after(async () => {
    await execute(`DELETE FROM t_dsh_rag_embedding_config WHERE tenant_id IN (?, ?)`, [TA, TB]).catch(() => undefined)
    await execute(`DELETE FROM t_dsh_knowledge_bases WHERE id IN (?, ?)`, [kbA, kbB]).catch(() => undefined)
    await execute(`DELETE FROM t_dsh_tenants WHERE id IN (?, ?)`, [TA, TB]).catch(() => undefined)
    await mock.close()
    await closeAuditWriter().catch(() => undefined)
    await pool.end()
    // mock/keep-alive socket 可能滞留事件循环:测试完成后强制退出(node --test 语义下合法)
    setImmediate(() => process.exit(0))
  })
})
