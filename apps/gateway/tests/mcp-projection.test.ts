/**
 * MCP 投影策略测试:URL/egress policy、serverName、credential env 名、patch 渲染不含 secret。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  validateMcpUrl, credentialEnvVarName, renderMcpPatchEntries, SERVER_NAME_RE,
} from '../src/mcp-projection.js'
import type { McpProjection } from '../src/mcp-projection.js'

const LOOPBACK_POLICY = { allowedOrigins: [], allowLoopback: true }
const ORIGIN_POLICY = { allowedOrigins: ['https://mcp.corp.example'], allowLoopback: false }

test('validateMcpUrl: accepts loopback only under loopback policy', () => {
  assert.equal(validateMcpUrl('http://127.0.0.1:9099/mcp', LOOPBACK_POLICY).ok, true)
  assert.equal(validateMcpUrl('http://127.0.0.1:9099/mcp', ORIGIN_POLICY).ok, false)
})

test('validateMcpUrl: accepts allowed origin, rejects others', () => {
  assert.equal(validateMcpUrl('https://mcp.corp.example/mcp', ORIGIN_POLICY).ok, true)
  const r = validateMcpUrl('https://evil.example/mcp', ORIGIN_POLICY)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.reason, 'origin-not-allowed')
})

test('validateMcpUrl: rejects userinfo, fragment, bad scheme, bad url', () => {
  const p = LOOPBACK_POLICY
  assert.equal(validateMcpUrl('http://user:pass@127.0.0.1/mcp', p).ok, false)
  assert.equal(validateMcpUrl('http://127.0.0.1/mcp#frag', p).ok, false)
  assert.equal(validateMcpUrl('ftp://127.0.0.1/mcp', p).ok, false)
  assert.equal(validateMcpUrl('not a url', p).ok, false)
})

test('SERVER_NAME_RE: kebab/snake/alnum only, 1-32 chars', () => {
  assert.ok(SERVER_NAME_RE.test('crm'))
  assert.ok(SERVER_NAME_RE.test('crm-tools_2'))
  assert.ok(SERVER_NAME_RE.test('A'.repeat(32)))
  assert.ok(!SERVER_NAME_RE.test(''))
  assert.ok(!SERVER_NAME_RE.test('a'.repeat(33)))
  assert.ok(!SERVER_NAME_RE.test('bad name'))
  assert.ok(!SERVER_NAME_RE.test('bad.name'))
})

test('credentialEnvVarName: stable, server-generated, no display input', () => {
  const a = credentialEnvVarName('11111111-1111-1111-1111-111111111111')
  const b = credentialEnvVarName('11111111-1111-1111-1111-111111111111')
  assert.equal(a, b)
  assert.match(a, /^CMCC_MCP_SECRET_[0-9A-F]{16}$/)
  assert.notEqual(a, credentialEnvVarName('22222222-2222-2222-2222-222222222222'))
})

test('renderMcpPatchEntries: no secret value, uses env reference', () => {
  const projection: McpProjection = {
    schemaVersion: 1, revision: 'r', generatedAt: '', tenantId: 't', userId: 'u',
    servers: [{
      connectorId: '11111111-1111-1111-1111-111111111111', serverName: 'crm',
      transport: 'streamable-http', url: 'https://mcp.corp.example/mcp',
      credentialEnvVar: 'CMCC_MCP_SECRET_ABCDEF0123456789', authType: 'bearer', toolCallTimeoutMs: 60000,
    }],
    excluded: [],
  }
  const entries = renderMcpPatchEntries(projection)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.name, '@deepseek-ai/dsh-mcp-client')
  assert.equal(entries[0]?.config.serverName, 'crm')
  const headers = entries[0]?.config.headers as Record<string, string>
  assert.match(headers.Authorization as string, /\$\{process\.env\.CMCC_MCP_SECRET_/)
  // 不含任何真实 secret value。
  assert.ok(!JSON.stringify(entries).includes('actual-secret'))
})