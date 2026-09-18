/**
 * cmcc-mcp-observer 测试:从工具 schema 提取 mcp__ 工具并分组。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupMcpTools } from '../src/index.js'

test('groupMcpTools: groups mcp__ tools by serverName', () => {
  const servers = groupMcpTools([
    { name: 'mcp__crm__search_customer' },
    { name: 'mcp__crm__create_customer' },
    { name: 'mcp__web__fetch' },
    { name: 'knowledge_search' },
    { name: 'bash' },
  ])
  assert.equal(servers.length, 2)
  assert.deepEqual(servers[0], { serverName: 'crm', toolCount: 2, tools: ['mcp__crm__create_customer', 'mcp__crm__search_customer'] })
  assert.deepEqual(servers[1], { serverName: 'web', toolCount: 1, tools: ['mcp__web__fetch'] })
})

test('groupMcpTools: ignores non-mcp tools and malformed names', () => {
  const servers = groupMcpTools([
    { name: 'mcp__' },
    { name: 'mcp__bad name__x' },
    { name: 'not-a-tool' },
    { name: 123 },
  ])
  assert.equal(servers.length, 0)
})

test('groupMcpTools: empty input', () => {
  assert.deepEqual(groupMcpTools([]), [])
})