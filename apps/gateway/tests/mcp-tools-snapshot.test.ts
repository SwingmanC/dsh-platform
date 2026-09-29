/**
 * MCP-V1.1 集成单测:discovery snapshot 持久化(真实 MySQL,自建 fixture,结束清理)。
 * 覆盖:save / replace / 失败保留 / 空数组 / 可见性读回 / 死端口 service 探针。
 * 前置:MySQL 已运行。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import { execute, queryOne, pool } from '../src/db.js'
import { closeAuditWriter } from '../src/repositories/audit-repository.js'
import { mcpRepository } from '../src/repositories/mcp-repository.js'
import { mcpService } from '../src/services/mcp-service.js'

const TA = randomUUID()
const TB = randomUUID()
const kbA = randomUUID()
const connOk = randomUUID()    // 正常连接器(测试不真正连接)
const connDead = randomUUID()  // 指向死端口的连接器(模拟失败测试)
const userId = randomUUID()
let creator = ''

interface ConnRow {
  discoveredTools?: Array<{ name: string; description: string | null; inputSchema?: unknown }>
}

async function findConn(ctx: { tenantId: string; userId: string }, id: string): Promise<ConnRow | undefined> {
  return (await mcpRepository.findById(ctx as never, id)) as unknown as ConnRow | undefined
}

describe('MCP-V1.1 discovery snapshot 持久化', () => {
  it('fixtures', async () => {
    const settings = JSON.stringify({})
    await execute(`INSERT INTO t_dsh_tenants (id, slug, name, settings) VALUES (?, ?, ?, ?)`, [TA, `mcp11-ta-${TA.slice(0, 8)}`, 'MCP11 A', settings])
    await execute(`INSERT INTO t_dsh_tenants (id, slug, name, settings) VALUES (?, ?, ?, ?)`, [TB, `mcp11-tb-${TB.slice(0, 8)}`, 'MCP11 B', settings])
    creator = (await queryOne<{ id: string }>(`SELECT id FROM t_dsh_users ORDER BY created_at LIMIT 1`))!.id  // fk_kb_user 需真实用户
    await execute(`INSERT INTO t_dsh_knowledge_bases (id, tenant_id, creator_id, name, visibility, status) VALUES (?, ?, ?, 'mcp11-kb', 'personal', 'active')`, [kbA, TA, creator])
    await execute(`INSERT INTO t_dsh_mcp_connectors (id, tenant_id, creator_id, name, server_name, transport, scope, visibility, status, endpoint_url, approved) VALUES (?, ?, ?, ?, ?, 'streamable-http', 'user', 'private', 'active', ?, 0)`,
      [connOk, TA, creator, 'mcp11-ok', 'mcp11-ok-server', `http://127.0.0.1:${randomUUID().slice(0, 4)}/mcp`])
    await execute(`INSERT INTO t_dsh_mcp_connectors (id, tenant_id, creator_id, name, server_name, transport, scope, visibility, status, endpoint_url, approved) VALUES (?, ?, ?, ?, ?, 'streamable-http', 'user', 'private', 'active', ?, 0)`,
      [connDead, TA, creator, 'mcp11-dead', 'mcp11-dead-server', 'http://127.0.0.1:1/mcp'])
    await execute(`INSERT INTO t_dsh_knowledge_mounts (id, user_id, kb_id, mount_type) VALUES (?, ?, ?, 'user')`, [randomUUID(), creator, kbA])
  })

  it('repository round-trip: save → read → replace → 空数组', async () => {
    const ctx = { tenantId: TA, userId: creator }
    const tools1 = [{ name: 'search', description: 'Search docs', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }, { name: 'fetch' }]
    await mcpRepository.setToolsSnapshot(connOk, tools1)
    const row1 = await findConn(ctx, connOk)
    assert.equal(row1!.discoveredTools?.length, 2)
    assert.deepEqual(row1!.discoveredTools![0]!.inputSchema, tools1[0]!.inputSchema)
    // replace:新快照完全覆盖(legacy 消失)
    const tools2 = [{ name: 'search-v2', description: null, inputSchema: { type: 'object' } }]
    await mcpRepository.setToolsSnapshot(connOk, tools2)
    const row2 = await findConn(ctx, connOk)
    assert.deepEqual(row2!.discoveredTools, tools2)
    // 空数组快照(§15 合法结果)
    await mcpRepository.setToolsSnapshot(connOk, [])
    const row3 = await findConn(ctx, connOk)
    assert.deepEqual(row3!.discoveredTools, [])
  })

  it('失败测试不破坏既有快照(service.testConnection 死端口 → provider-error)', async () => {
    // 预置快照
    const tools = [{ name: 'keep-me', description: null, inputSchema: {} }]
    await mcpRepository.setToolsSnapshot(connDead, tools)
    const ctx = { tenantId: TA, userId: creator, role: 'tenant_admin' as const, requestId: '', platformSessionId: '', deviceId: '' }
    const r = await mcpService.testConnection(ctx as never, connDead) as { ok: boolean; code?: string }
    assert.equal(r.ok, false)
    // 快照保留(失败不清除上次成功目录)
    const row = await findConn({ tenantId: TA, userId: creator }, connDead)
    assert.deepEqual(row!.discoveredTools, tools)
  })

  it('connector visibility: 非 creator 的其他租户用户不可读 connector(含 snapshot)', async () => {
    // creator 永远可见;其他租户用户:personal connector → creator/tenant/platform 三路均不匹配 → undefined
    const ctxB = { tenantId: TB, userId: randomUUID() }
    const row = await findConn(ctxB, connOk)
    assert.equal(row, undefined, '非 creator 不得读取他人 personal connector(含 snapshot)')
  })

  after(async () => {
    await execute(`DELETE FROM t_dsh_mcp_connectors WHERE name IN ('mcp11-ok','mcp11-dead')`).catch(() => undefined)
    await execute(`DELETE FROM t_dsh_knowledge_bases WHERE id = ?`, [kbA]).catch(() => undefined)
    await execute(`DELETE FROM t_dsh_tenants WHERE id IN (?, ?)`, [TA, TB]).catch(() => undefined)
    await closeAuditWriter().catch(() => undefined)
    await pool.end()
  })
})
