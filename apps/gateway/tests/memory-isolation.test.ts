import { describe, it, mock } from 'node:test'
import assert from 'node:assert'

/**
 * Memory 跨用户/跨租户隔离测试(纯逻辑层)。
 * 模拟 MemoryRepository 的行为验证 filter 正确性。
 */

interface MockMemory {
  id: string
  tenantId: string
  ownerUserId: string
  visibility: string
  content: string
}

class MockMemoryStore {
  records: MockMemory[] = [
    { id: 'm1', tenantId: 't1', ownerUserId: 'u1', visibility: 'personal', content: 'u1 personal' },
    { id: 'm2', tenantId: 't1', ownerUserId: 'u2', visibility: 'personal', content: 'u2 personal' },
    { id: 'm3', tenantId: 't1', ownerUserId: 'u1', visibility: 'tenant_shared', content: 't1 shared by u1' },
    { id: 'm4', tenantId: 't2', ownerUserId: 'u3', visibility: 'tenant_shared', content: 't2 shared by u3' },
  ]

  search(tenantId: string, userId: string, visibility?: string) {
    return this.records.filter((r) => {
      if (r.tenantId !== tenantId) return false
      if (visibility === 'personal') return r.ownerUserId === userId && r.visibility === 'personal'
      if (visibility === 'tenant_shared') return r.visibility === 'tenant_shared'
      return r.ownerUserId === userId || r.visibility === 'tenant_shared'
    })
  }
}

describe('Memory 跨租户隔离', () => {
  const store = new MockMemoryStore()

  it('Tenant A 用户看不到 Tenant B 的共享记忆', () => {
    const result = store.search('t1', 'u1', 'tenant_shared')
    assert.ok(result.every((r) => r.tenantId === 't1'))
    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0]!.id, 'm3')
  })

  it('用户 A 看不到用户 B 的私有记忆', () => {
    const result = store.search('t1', 'u1', 'personal')
    assert.ok(result.every((r) => r.ownerUserId === 'u1'))
    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0]!.id, 'm1')
  })

  it('同租户共享记忆对全员可见', () => {
    const r1 = store.search('t1', 'u1')
    const r2 = store.search('t1', 'u2')
    const shared1 = r1.filter((r) => r.visibility === 'tenant_shared')
    const shared2 = r2.filter((r) => r.visibility === 'tenant_shared')
    assert.strictEqual(shared1.length, shared2.length)
    assert.strictEqual(shared1[0]!.id, shared2[0]!.id)
  })

  it('默认搜索包含 personal + shared', () => {
    const result = store.search('t1', 'u1')
    const personal = result.filter((r) => r.visibility === 'personal')
    const shared = result.filter((r) => r.visibility === 'tenant_shared')
    assert.strictEqual(personal.length, 1)
    assert.strictEqual(shared.length, 1)
  })
})