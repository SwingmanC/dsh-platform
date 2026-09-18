import { describe, it } from 'node:test'
import assert from 'node:assert'

interface MockMcp {
  id: string; tenantId: string; creatorId: string; name: string; transport: string; scope: string; approved: boolean
}

class MockMcpStore {
  servers: MockMcp[] = [
    { id: 'm1', tenantId: 't1', creatorId: 'u1', name: 'my-tool', transport: 'streamable-http', scope: 'user', approved: true },
    { id: 'm2', tenantId: 't1', creatorId: 'u2', name: 'team-db', transport: 'streamable-http', scope: 'tenant', approved: true },
    { id: 'm3', tenantId: 't2', creatorId: 'u3', name: 'other-db', transport: 'streamable-http', scope: 'tenant', approved: true },
    { id: 'm4', tenantId: 't1', creatorId: 'u1', name: 'local-script', transport: 'stdio', scope: 'user', approved: false },
  ]

  authorizations: Set<string> = new Set()

  list(tenantId: string, userId: string) {
    return this.servers.filter((s) =>
      s.creatorId === userId || (s.scope === 'tenant' && s.tenantId === tenantId) || s.scope === 'platform'
    )
  }

  isAuthorized(userId: string, serverId: string) {
    return this.authorizations.has(`${userId}:${serverId}`)
  }

  authorize(userId: string, serverId: string) {
    const server = this.servers.find((s) => s.id === serverId)
    if (!server) return false
    if (server.transport === 'stdio' && !server.approved) return false
    this.authorizations.add(`${userId}:${serverId}`)
    return true
  }
}

describe('MCP 跨租户隔离', () => {
  const store = new MockMcpStore()

  it('user scope 仅创建者可见', () => {
    const r1 = store.list('t1', 'u1')
    const r2 = store.list('t1', 'u2')
    assert.ok(r1.some((s) => s.id === 'm1'))
    assert.ok(!r2.some((s) => s.id === 'm1'))
  })

  it('tenant scope 同租户可见', () => {
    const r = store.list('t1', 'u1')
    assert.ok(r.some((s) => s.id === 'm2'))
  })

  it('跨租户看不到对方 tenant MCP', () => {
    const r = store.list('t1', 'u1')
    assert.ok(!r.some((s) => s.id === 'm3'))
  })

  it('stdio 未审批不能授权', () => {
    const ok = store.authorize('u1', 'm4')
    assert.ok(!ok)
  })

  it('HTTP 已审批可授权', () => {
    const ok = store.authorize('u1', 'm1')
    assert.ok(ok)
  })
})