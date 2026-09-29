/**
 * MCP-V1.1 单测:工具目录提取与安全边界(纯函数,无网络/DB)。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toToolCatalog, MAX_DISCOVERED_TOOLS, MAX_TOOL_SCHEMA_CHARS, MAX_SNAPSHOT_CHARS, McpTestError } from '../src/mcp-test.js'

const okTool = (name: string, schemaProps: Record<string, unknown> = { q: { type: 'string' } }) => ({
  name,
  description: `desc for ${name}`,
  inputSchema: { type: 'object', properties: schemaProps },
})

test('listTools 提取:name/description/inputSchema 原样保留;缺省补 {}', () => {
  const tools = toToolCatalog([okTool('search'), { name: 'legacy', inputSchema: { type: 'object' } }])
  assert.equal(tools.length, 2)
  assert.equal(tools[0]!.name, 'search')
  assert.equal(tools[0]!.description, 'desc for search')
  assert.deepEqual(tools[0]!.inputSchema, { type: 'object', properties: { q: { type: 'string' } } })
  // 无 description → null;inputSchema 原样透传
  assert.equal(tools[1]!.description, null)
  assert.deepEqual(tools[1]!.inputSchema, { type: 'object' })
})

test('数量上限:超过 200 → too-many-tools', () => {
  const many = Array.from({ length: MAX_DISCOVERED_TOOLS + 1 }, (_, i) => okTool(`t${i}`))
  assert.throws(() => toToolCatalog(many), (e: unknown) => (e as McpTestError).code === 'too-many-tools')
  // 恰好 200 → 通过
  const exact = Array.from({ length: MAX_DISCOVERED_TOOLS }, (_, i) => okTool(`t${i}`))
  assert.equal(toToolCatalog(exact).length, MAX_DISCOVERED_TOOLS)
})

test('单 tool schema 超限 → tool-schema-too-large', () => {
  const big = okTool('big', { blob: 'x'.repeat(MAX_TOOL_SCHEMA_CHARS + 1) })
  assert.throws(() => toToolCatalog([big]), (e: unknown) => (e as McpTestError).code === 'tool-schema-too-large')
})

test('快照总量超限 → snapshot-too-large', () => {
  // 每工具 ~10KB × 30 = ~300KB > 256KB
  const many = Array.from({ length: 30 }, (_, i) => okTool(`t${i}`, { blob: 'x'.repeat(10 * 1024) }))
  assert.throws(() => toToolCatalog(many), (e: unknown) => (e as McpTestError).code === 'snapshot-too-large')
})

test('畸形条目:name 缺失/非字符串 → invalid-tools-response', () => {
  for (const bad of [{ description: 'no name' }, { inputSchema: {} }, 'not-an-object']) {
    assert.throws(() => toToolCatalog([bad as unknown]), McpTestError)
  }
})

test('空 tools 合法(§15):返回 []', () => {
  assert.deepEqual(toToolCatalog([]), [])
})
