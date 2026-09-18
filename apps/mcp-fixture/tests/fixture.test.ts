/**
 * MCP fixture 测试:真实 MCP protocol 往返(官方 SDK client → fixture server)。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startFixture, FIXTURE_MARKER } from '../src/index.js'

test('fixture: real MCP handshake + tools/list + cmcc_marker call', async () => {
  const fixture = await startFixture(0)
  const client = new Client({ name: 'fixture-test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(fixture.url))
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    const names = tools.tools.map((t) => t.name).sort()
    assert.deepEqual(names, ['cmcc_echo', 'cmcc_marker'])
    const result = await client.callTool({ name: 'cmcc_marker', arguments: {} })
    const content = result.content as Array<{ type: string; text?: string }>
    assert.equal(content[0]?.type, 'text')
    assert.equal(content[0]?.text, FIXTURE_MARKER)
    const echo = await client.callTool({ name: 'cmcc_echo', arguments: { text: 'hi' } })
    const echoContent = echo.content as Array<{ type: string; text?: string }>
    assert.equal(echoContent[0]?.text, 'echo:hi')
  } finally {
    await client.close().catch(() => undefined)
    await fixture.close()
  }
})

test('fixture: auth enforced when MCP_FIXTURE_TOKEN set', async () => {
  process.env.MCP_FIXTURE_TOKEN = 'test-secret-token'
  const fixture = await startFixture(0)
  const client = new Client({ name: 'fixture-test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(fixture.url))
  try {
    await assert.rejects(async () => { await client.connect(transport) })
  } finally {
    await client.close().catch(() => undefined)
    await fixture.close()
    delete process.env.MCP_FIXTURE_TOKEN
  }
})