import { describe, it } from 'node:test'
import assert from 'node:assert'

interface MockSkill {
  id: string; tenantId: string; creatorId: string; name: string; visibility: string; status: string
}

class MockSkillStore {
  skills: MockSkill[] = [
    { id: 's1', tenantId: 't1', creatorId: 'u1', name: 'net-ops', visibility: 'public', status: 'published' },
    { id: 's2', tenantId: 't1', creatorId: 'u1', name: 'private-tool', visibility: 'private', status: 'published' },
    { id: 's3', tenantId: 't1', creatorId: 'u2', name: 'team-script', visibility: 'tenant', status: 'published' },
    { id: 's4', tenantId: 't2', creatorId: 'u3', name: 'other-tenant', visibility: 'public', status: 'published' },
    { id: 's5', tenantId: 't1', creatorId: 'u1', name: 'draft-skill', visibility: 'private', status: 'draft' },
  ]

  search(tenantId: string, userId: string) {
    return this.skills.filter((s) => {
      if (s.visibility === 'public') return true
      if (s.visibility === 'tenant') return s.tenantId === tenantId
      if (s.visibility === 'private') return s.creatorId === userId
      return false
    })
  }
}

describe('Skill 跨租户隔离', () => {
  const store = new MockSkillStore()

  it('public skill 对所有人可见', () => {
    const r1 = store.search('t1', 'u1').filter((s) => s.visibility === 'public')
    const r2 = store.search('t2', 'u3').filter((s) => s.visibility === 'public')
    assert.ok(r1.some((s) => s.id === 's1'))
    assert.ok(r2.some((s) => s.id === 's1'))
  })

  it('private skill 只有作者可见', () => {
    const r1 = store.search('t1', 'u1')
    const r2 = store.search('t1', 'u2')
    assert.ok(r1.some((s) => s.id === 's2'))
    assert.ok(!r2.some((s) => s.id === 's2'))
  })

  it('tenant skill 只对本租户可见', () => {
    const r1 = store.search('t1', 'u2')
    const r2 = store.search('t2', 'u3')
    assert.ok(r1.some((s) => s.id === 's3'))
    assert.ok(!r2.some((s) => s.id === 's3'))
  })

  it('跨租户看不到 private skill', () => {
    const r = store.search('t2', 'u3')
    assert.ok(!r.some((s) => s.id === 's2'))
    assert.ok(!r.some((s) => s.id === 's3'))
  })

  it('draft skill 仅作者可见', () => {
    const r1 = store.search('t1', 'u1')
    const r2 = store.search('t1', 'u2')
    assert.ok(r1.some((s) => s.id === 's5'))
    assert.ok(!r2.some((s) => s.id === 's5'))
  })
})