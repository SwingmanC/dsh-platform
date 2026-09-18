import { describe, it } from 'node:test'
import assert from 'node:assert'

interface MockKb {
  id: string; tenantId: string; creatorId: string; name: string; visibility: string
}

interface MockDoc {
  id: string; kbId: string; content: string
}

class MockKbStore {
  kbs: MockKb[] = [
    { id: 'kb1', tenantId: 't1', creatorId: 'u1', name: 'my-personal', visibility: 'personal' },
    { id: 'kb2', tenantId: 't1', creatorId: 'u2', name: 'team-manual', visibility: 'tenant' },
    { id: 'kb3', tenantId: 't2', creatorId: 'u3', name: 'other-team', visibility: 'tenant' },
  ]

  docs: MockDoc[] = [
    { id: 'd1', kbId: 'kb1', content: 'u1 personal doc' },
    { id: 'd2', kbId: 'kb2', content: 'team doc content' },
    { id: 'd3', kbId: 'kb3', content: 'other team content' },
  ]

  listBases(tenantId: string, userId: string) {
    return this.kbs.filter((kb) => kb.creatorId === userId || (kb.visibility === 'tenant' && kb.tenantId === tenantId))
  }

  searchDocs(kbId: string, userId: string, tenantId: string) {
    const kb = this.kbs.find((k) => k.id === kbId)
    if (!kb) return []
    if (kb.creatorId === userId) return this.docs.filter((d) => d.kbId === kbId)
    if (kb.visibility === 'tenant' && kb.tenantId === tenantId) return this.docs.filter((d) => d.kbId === kbId)
    return []
  }
}

describe('Knowledge Base 跨租户隔离', () => {
  const store = new MockKbStore()

  it('personal KB 仅创建者可见', () => {
    const r1 = store.listBases('t1', 'u1')
    const r2 = store.listBases('t1', 'u2')
    assert.ok(r1.some((kb) => kb.id === 'kb1'))
    assert.ok(!r2.some((kb) => kb.id === 'kb1'))
  })

  it('tenant KB 同租户可见', () => {
    const r1 = store.listBases('t1', 'u1')
    const r2 = store.listBases('t1', 'u2')
    assert.ok(r1.some((kb) => kb.id === 'kb2'))
    assert.ok(r2.some((kb) => kb.id === 'kb2'))
  })

  it('跨租户看不到对方 tenant KB', () => {
    const r = store.listBases('t1', 'u1')
    assert.ok(!r.some((kb) => kb.id === 'kb3'))
  })

  it('无权限用户搜索文档返回空', () => {
    const d1 = store.searchDocs('kb1', 'u2', 't1')
    const d2 = store.searchDocs('kb1', 'u1', 't1')
    assert.strictEqual(d1.length, 0)
    assert.strictEqual(d2.length, 1)
  })

  it('tenant KB 文档同租户可查', () => {
    const d = store.searchDocs('kb2', 'u1', 't1')
    assert.strictEqual(d.length, 1)
  })
})