/**
 * K-T6-FINAL 工具级契约测试:knowledge_search → Gateway /internal/knowledge/search。
 * - 带 x-runtime-token;body 仅 query/knowledgeBase/limit(身份由 Gateway 反解,不得出现身份字段);
 * - Gateway hybrid 结果透传(含 retrievalMode);
 * - Gateway 失败/未配置 internal channel → 回退本地投影关键词匹配(既有行为)。
 * 无 DSH Runtime、无 DB;Gateway 用进程内 mock http server 模拟。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { apply } from '../src/index.js'

interface CapturedTool {
  name: string
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown>
}

function makeRuntime(projDir: string): Map<string, CapturedTool> {
  const registered = new Map<string, CapturedTool>()
  const ctx = {
    tools: {
      register(def: CapturedTool & { description?: string; parameters?: unknown; output?: unknown; timeoutMs?: number }): () => void {
        registered.set(def.name, { name: def.name, execute: def.execute })
        return () => {}
      },
    },
  }
  process.env.PLATFORM_KNOWLEDGE_PROJECTION_DIR = projDir
  apply(ctx as unknown as Parameters<typeof apply>[0])
  return registered
}

async function makeProjection(dir: string, chunks: Array<{ chunkId: string; snippet: string }>): Promise<void> {
  await mkdir(dir, { recursive: true })
  const data = {
    schemaVersion: 1, revision: 'kt6f-test', generatedAt: new Date().toISOString(),
    tenantId: 't1', userId: 'u1',
    chunks: chunks.map((c) => ({
      chunkId: c.chunkId, docId: `doc-${c.chunkId}`, kbId: `kb-${c.chunkId}`,
      kbName: 'TestKB', documentTitle: c.snippet.includes('CMCC_PDF') ? 'sample.pdf' : 'note.md',
      ordinal: 0, snippet: c.snippet, score: 0,
    })),
    mountedKbIds: ['kb-1'],
  }
  await writeFile(path.join(dir, 'projection.json'), JSON.stringify(data), 'utf8')
}

interface MockGateway {
  port: number
  requests: Array<{ auth?: string; body?: string }>
  close(): Promise<void>
}

async function startMockGateway(handler: (body: { query?: string; knowledgeBase?: string; limit?: number }, auth: string | undefined, res: import('node:http').ServerResponse) => void): Promise<MockGateway> {
  const requests: MockGateway['requests'] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => { raw += c.toString('utf8') })
    req.on('end', () => {
      let body: { query?: string; knowledgeBase?: string; limit?: number } = {}
      try { body = JSON.parse(raw) } catch { /* ignore */ }
      const auth = typeof req.headers['x-runtime-token'] === 'string' ? req.headers['x-runtime-token'] as string : undefined
      requests.push({ auth, body: raw })
      handler(body, auth, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = address !== null && typeof address === 'object' ? address.port : 0
  return {
    port, requests,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.() }),
  }
}

const TOKEN = 'kt6f-runtime-token-abcdef'

after(() => {
  delete process.env.PLATFORM_MEMORY_INTERNAL_URL
  delete process.env.PLATFORM_MEMORY_INTERNAL_TOKEN
  delete process.env.PLATFORM_KNOWLEDGE_PROJECTION_DIR
})

describe('knowledge_search → Gateway hybrid(Runtime tool 契约)', () => {
  it('§11 语义透传:带 token、body 无身份字段、retrievalMode=hybrid 透传', async () => {
    const projDir = await mkdtemp(path.join(tmpdir(), 'kt6f-'))
    await makeProjection(projDir, [{ chunkId: 'local-1', snippet: 'local fallback body' }])
    const gw = await startMockGateway((_body, _auth, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        results: [{
          chunkId: 'sem-1', snippet: '员工差旅可以报销城际交通费用', knowledgeBase: 'HR', documentTitle: 'travel.md', score: 1,
          citation: {
            citationId: 'kb:kb-hr:doc:doc-hr:ver:ver-1:chunk:sem-1', kbId: 'kb-hr', documentId: 'doc-hr',
            documentVersionId: 'ver-1', chunkId: 'sem-1', chunkIndex: 0, documentTitle: 'travel.md',
          },
        }],
        retrievalMode: 'hybrid',
      }))
    })
    process.env.PLATFORM_MEMORY_INTERNAL_URL = `http://127.0.0.1:${gw.port}`
    process.env.PLATFORM_MEMORY_INTERNAL_TOKEN = TOKEN
    const tools = makeRuntime(projDir)
    try {
      const search = tools.get('knowledge_search')!
      assert.ok(search, 'knowledge_search tool 应已注册')
      const out = await search.execute(
        { query: 'Can I get reimbursed for a high-speed rail ticket on a work trip?', limit: 5 },
        { signal: new AbortController().signal },
      ) as { results: Array<{ chunkId: string; citation?: { citationId: string } }>; retrievalMode?: string }
      assert.equal(out.retrievalMode, 'hybrid')
      assert.equal(out.results[0]!.chunkId, 'sem-1')
      // K-T7:citation 透传(向后兼容:核心字段仍在)
      assert.equal(out.results[0]!.citation!.citationId, 'kb:kb-hr:doc:doc-hr:ver:ver-1:chunk:sem-1')
      // 契约:token 头必须携带;body 不得携带身份字段
      assert.equal(gw.requests[0]!.auth, TOKEN)
      const sent = JSON.parse(gw.requests[0]!.body ?? '{}') as Record<string, unknown>
      assert.equal(sent.query, 'Can I get reimbursed for a high-speed rail ticket on a work trip?')
      assert.ok(!('tenantId' in sent) && !('userId' in sent), 'body 不得包含身份字段')
    } finally {
      await gw.close()
      delete process.env.PLATFORM_MEMORY_INTERNAL_URL
      delete process.env.PLATFORM_MEMORY_INTERNAL_TOKEN
      await rm(projDir, { recursive: true, force: true })
    }
  })

  it('§12/§13 Gateway 失败 → 回退本地投影关键词匹配', async () => {
    const projDir = await mkdtemp(path.join(tmpdir(), 'kt6f-'))
    await makeProjection(projDir, [{ chunkId: 'local-marker', snippet: 'CMCC_PDF_KNOWLEDGE_TEST body' }])
    const gw = await startMockGateway((_body, _auth, res) => { res.writeHead(401); res.end('{}') })
    process.env.PLATFORM_MEMORY_INTERNAL_URL = `http://127.0.0.1:${gw.port}`
    process.env.PLATFORM_MEMORY_INTERNAL_TOKEN = TOKEN
    const tools = makeRuntime(projDir)
    try {
      const search = tools.get('knowledge_search')!
      const out = await search.execute(
        { query: 'CMCC_PDF_KNOWLEDGE_TEST', limit: 5 },
        { signal: new AbortController().signal },
      ) as { results: Array<{ chunkId: string; snippet: string }> }
      assert.ok(out.results.some((r) => r.chunkId === 'local-marker' && r.snippet.includes('CMCC_PDF_KNOWLEDGE_TEST')))
    } finally {
      await gw.close()
      delete process.env.PLATFORM_MEMORY_INTERNAL_URL
      delete process.env.PLATFORM_MEMORY_INTERNAL_TOKEN
      await rm(projDir, { recursive: true, force: true })
    }
  })

  it('未配置 internal channel → 直接本地投影(既有行为)', async () => {
    delete process.env.PLATFORM_MEMORY_INTERNAL_URL
    delete process.env.PLATFORM_MEMORY_INTERNAL_TOKEN
    const projDir = await mkdtemp(path.join(tmpdir(), 'kt6f-'))
    await makeProjection(projDir, [{ chunkId: 'local-2', snippet: 'plain keyword body KT6F' }])
    const tools = makeRuntime(projDir)
    const search = tools.get('knowledge_search')!
    const out = await search.execute(
      { query: 'KT6F', limit: 5 },
      { signal: new AbortController().signal },
    ) as { results: Array<{ chunkId: string }> }
    assert.ok(out.results.some((r) => r.chunkId === 'local-2'))
    await rm(projDir, { recursive: true, force: true })
  })
})

void randomUUID
