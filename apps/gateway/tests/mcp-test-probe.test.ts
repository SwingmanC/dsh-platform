/**
 * MCP 连接测试(任务 02)纯函数测试:URL 策略的元数据地址硬拒绝 + secret 脱敏。
 * 不发起任何网络请求;探针网络路径由人工验收覆盖。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import net from 'node:net'
import { validateMcpUrl } from '../src/mcp-projection.js'
import { probeMcpServer, redactSecrets } from '../src/mcp-test.js'
import type { McpEgressPolicy } from '../src/mcp-projection.js'

const allowAllLoopback: McpEgressPolicy = { allowedOrigins: [], allowLoopback: true }

test('validateMcpUrl: rejects cloud metadata hosts even when allowlisted', () => {
  const allowMetadata: McpEgressPolicy = {
    allowedOrigins: ['http://169.254.169.254', 'http://metadata.google.internal'],
    allowLoopback: true,
  }
  const a = validateMcpUrl('http://169.254.169.254/latest/meta-data', allowMetadata)
  assert.equal(a.ok, false)
  if (!a.ok) assert.equal(a.reason, 'metadata-host-forbidden')
  const b = validateMcpUrl('http://metadata.google.internal/computeMetadata/v1', allowMetadata)
  assert.equal(b.ok, false)
  if (!b.ok) assert.equal(b.reason, 'metadata-host-forbidden')
})

test('validateMcpUrl: keeps existing behavior (loopback flag, origin allowlist, scheme)', () => {
  assert.equal(validateMcpUrl('http://127.0.0.1:9099/mcp', allowAllLoopback).ok, true)
  assert.equal(validateMcpUrl('http://127.0.0.1:9099/mcp', { allowedOrigins: [], allowLoopback: false }).ok, false)
  assert.equal(validateMcpUrl('https://mcp.corp.example/mcp', {
    allowedOrigins: ['https://mcp.corp.example'], allowLoopback: false,
  }).ok, true)
  assert.equal(validateMcpUrl('ftp://mcp.corp.example', allowAllLoopback).ok, false)
  assert.equal(validateMcpUrl('http://user:pass@x.example', allowAllLoopback).ok, false)
})

test('redactSecrets: replaces secret occurrences and truncates long messages', () => {
  const out = redactSecrets('fetch failed with token sk-abcdef123456 and more', ['sk-abcdef123456'])
  assert.ok(!out.includes('sk-abcdef123456'))
  assert.ok(out.includes('******'))
  const long = 'x'.repeat(400)
  assert.ok(redactSecrets(long, []).length <= 301)
  // 短于 4 字符的候选不参与替换(避免误伤普通短词)。
  assert.equal(redactSecrets('abc def', ['abc']), 'abc def')
})

test('probeMcpServer: hard timeout settles with test-timeout and closes client', async () => {
  // 裸 TCP 服务:接受连接但永不响应 → connect 悬挂 → 硬超时必须结算。
  const server = net.createServer((socket) => { /* 故意不回包 */ })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  try {
    const r = await probeMcpServer({ url: `http://127.0.0.1:${address.port}/mcp`, timeoutMs: 1500 })
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.code, 'test-timeout')
      assert.ok(r.durationMs >= 1400 && r.durationMs < 5000)
      assert.ok(!r.message.toLowerCase().includes('stack'))
    }
  } finally {
    server.close()
  }
})

test('probeMcpServer: redacts bearer header value from failure message', async () => {
  // 无监听端口快速拒绝;注入一个含标记值的 header,断言失败消息中不出现。
  const marker = 'sk-probe-leak-check-0001'
  const r = await probeMcpServer({ url: 'http://127.0.0.1:1/mcp', headers: { authorization: `Bearer ${marker}` }, timeoutMs: 5000 })
  assert.equal(r.ok, false)
  if (!r.ok) assert.ok(!r.message.includes(marker))
})
