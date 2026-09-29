/**
 * K-T3 单测:Embedding Client(mock HTTP server,无真实外部 Provider)。
 * 覆盖:合法响应 / 分批 20+1 / 401 / 超时 abort / 维度不匹配 / 非法向量 / SSRF。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Server } from 'node:http'
import http from 'node:http'
import { embedTexts, resolveEmbeddingEndpoint } from '../src/rag/embedding-client.js'

interface MockServer { port: number; close(): Promise<void>; requests: Array<{ model?: unknown; input?: unknown; auth?: string | undefined }> }

async function startMock(handler: (body: { model?: unknown; input?: unknown }, auth: string | undefined, res: http.ServerResponse) => void): Promise<MockServer> {
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => { raw += c.toString('utf8') })
    req.on('end', () => {
      let body: { model?: unknown; input?: unknown } = {}
      try { body = JSON.parse(raw) } catch { /* ignore */ }
      handler(body, req.headers.authorization, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = address !== null && typeof address === 'object' ? address.port : 0
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    requests: [],
  }
}

const POLICY = { allowedOrigins: [] as string[], allowLoopback: true }

const CFG = (port: number, dims = 4, apiKey: string | null = null) => ({
  baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test-embed', dims, apiKey,
})

test('Case 1: 合法响应 1 input → 1 vector,dims 校验通过', async () => {
  const m = await startMock((body, _auth, res) => {
    m.requests.push(body)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: (body.input as string[]).map(() => ({ embedding: [0.1, 0.2, 0.3, 0.4] })) }))
  })
  try {
    const out = await embedTexts(CFG(m.port, 4), ['CMCC_EMBEDDING_CONNECTION_TEST'], { egressPolicy: POLICY })
    assert.equal(out.length, 1)
    assert.deepEqual(out[0], [0.1, 0.2, 0.3, 0.4])
    assert.equal(m.requests.length, 1)
    assert.equal(m.requests[0]!.model, 'test-embed')
  } finally { await m.close() }
})

test('Case 2: 21 inputs 分批为 20 + 1', async () => {
  const sizes: number[] = []
  const m = await startMock((body, _auth, res) => {
    const input = body.input as string[]
    sizes.push(input.length)
    m.requests.push(body)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: input.map(() => ({ embedding: [1, 2] })) }))
  })
  try {
    const texts = Array.from({ length: 21 }, (_, i) => `t${i}`)
    const out = await embedTexts(CFG(m.port, 2), texts, { egressPolicy: POLICY })
    assert.equal(out.length, 21)
    assert.deepEqual(sizes, [20, 1])
  } finally { await m.close() }
})

test('Case 3: 401 → 结构化 provider-error,不泄漏 API Key', async () => {
  const secret = 'sk-super-secret-key-9876'
  const m = await startMock((_body, _auth, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
  })
  try {
    await assert.rejects(
      embedTexts(CFG(m.port, 4, secret), ['x'], { egressPolicy: POLICY }),
      (err: unknown) => {
        const e = err as { code?: string; message?: string }
        assert.equal(e.code, 'provider-error:401')
        assert.ok(!e.message!.includes(secret))
        return true
      },
    )
  } finally { await m.close() }
})

test('Case 4: 超时 → 注入短超时后 abort,返回 embedding-timeout', async () => {
  // 服务器接受连接但永不响应 → 触发 AbortController 硬超时
  const m = await startMock((_body, _auth, res) => { /* 故意不响应 */ res.on('close', () => {}) })
  try {
    await assert.rejects(
      embedTexts(CFG(m.port, 4), ['x'], { timeoutMs: 300, egressPolicy: POLICY }),
      (err: unknown) => {
        const e = err as { code?: string }
        assert.equal(e.code, 'embedding-timeout')
        return true
      },
    )
  } finally { await m.close() }
})

test('Case 5: 维度不匹配 → dimension-mismatch', async () => {
  const m = await startMock((body, _auth, res) => {
    const input = body.input as string[]
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: input.map(() => ({ embedding: [1, 2, 3, 4] })) }))
  })
  try {
    await assert.rejects(
      embedTexts(CFG(m.port, 3), ['x'], { egressPolicy: POLICY }),
      (err: unknown) => (err as { code?: string }).code === 'dimension-mismatch',
    )
  } finally { await m.close() }
})

test('Case 6: 非法向量(null/string/空)→ embedding-response-invalid', async () => {
  for (const bad of [[null], ['abc'], []]) {
    const m = await startMock((_body, _auth, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ embedding: bad }] }))
    })
    try {
      await assert.rejects(
        embedTexts(CFG(m.port, 0), ['x'], { egressPolicy: POLICY }),
        (err: unknown) => (err as { code?: string }).code === 'embedding-response-invalid',
      )
    } finally { await m.close() }
  }
})

test('Case 9: SSRF — metadata 地址在出站前拒绝', async () => {
  await assert.rejects(
    embedTexts({ baseUrl: 'http://169.254.169.254/v1', model: 'm', dims: 4, apiKey: null }, ['x']),
    (err: unknown) => {
      const e = err as { code?: string }
      assert.equal(e.code, 'embedding-config-invalid:metadata-host-forbidden')
      return true
    },
  )
})

test('默认策略:未提供 egress policy 时 deny(loopback 也不放行)', async () => {
  assert.throws(
    () => resolveEmbeddingEndpoint('http://127.0.0.1:9/v1'),
    /embedding-config-invalid:origin-not-allowed/,
  )
})
