/**
 * MCP patch 渲染测试:官方 dsh-mcp-client row 结构、!!js env 引用、无 secret value。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderMcpEntry } from '../src/profile-patch.js'
import type { McpPatchEntry } from '../src/mcp-projection.js'

const SECRET = 'ACTUAL_SECRET_VALUE_MUST_NOT_APPEAR'

test('renderMcpEntry: emits official plugin row with !!js env reference', () => {
  const entry: McpPatchEntry = {
    id: 'cmcc-mcp-11111111-1111-1111-1111-111111111111',
    name: '@deepseek-ai/dsh-mcp-client',
    config: {
      serverName: 'crm',
      transport: 'streamable-http',
      url: 'https://mcp.corp.example/mcp',
      headers: { Authorization: 'Bearer ${process.env.CMCC_MCP_SECRET_ABCDEF0123456789}' },
      toolCallTimeoutMs: 60000,
      failOnStartupError: false,
    },
  }
  const yaml = renderMcpEntry(entry)
  assert.match(yaml, /name: "@deepseek-ai\/dsh-mcp-client"/)
  assert.match(yaml, /serverName: "crm"/)
  assert.match(yaml, /transport: streamable-http/)
  assert.match(yaml, /Authorization: !!js '`Bearer \$\{process\.env\.CMCC_MCP_SECRET_ABCDEF0123456789\}`'/)
  // 不包含任何 secret value。
  assert.ok(!yaml.includes(SECRET))
})

test('renderMcpEntry: no headers renders empty map', () => {
  const entry: McpPatchEntry = {
    id: 'cmcc-mcp-2', name: '@deepseek-ai/dsh-mcp-client',
    config: { serverName: 'web', transport: 'streamable-http', url: 'https://x.example/mcp', headers: {}, toolCallTimeoutMs: 60000, failOnStartupError: false },
  }
  const yaml = renderMcpEntry(entry)
  assert.match(yaml, /headers: \{\}/)
})