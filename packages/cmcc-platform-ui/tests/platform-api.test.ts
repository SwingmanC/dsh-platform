/**
 * PlatformApiClient 测试:URL / method / CSRF / 错误归一(注入 mock fetch,无网络)。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PlatformApiClient, PlatformApiError } from '../src/client/platform-api.ts'

interface Call { url: string; init: RequestInit | undefined }

function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown; throw?: boolean }): {
  fetchImpl: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const result = handler(url, init)
    if (result.throw === true) throw new TypeError('Failed to fetch')
    const status = result.status ?? 200
    const body = result.body === undefined ? '' : JSON.stringify(result.body)
    return new Response(body, { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

test('listSkills: GET /api/skills with query + credentials include', async () => {
  const { fetchImpl, calls } = mockFetch(() => ({ body: { skills: [], total: 0 } }))
  const api = new PlatformApiClient(fetchImpl)
  const result = await api.listSkills({ q: 'net', limit: 20 })
  assert.equal(result.total, 0)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /^\/api\/skills\?/)
  assert.match(calls[0].url, /q=net/)
  assert.equal(calls[0].init?.method, undefined)
  assert.equal(calls[0].init?.credentials, 'include')
})

test('usage: current role and summary use authenticated GET requests', async () => {
  const { fetchImpl, calls } = mockFetch((url) => ({ body: url === '/auth/me' ? { role: 'tenant_admin' } : { totals: { turns: 0 }, daily: [], users: [], models: [] } }))
  const api = new PlatformApiClient(fetchImpl)
  assert.equal((await api.getCurrentUser()).role, 'tenant_admin')
  assert.equal((await api.getUsageSummary(7)).totals.turns, 0)
  assert.deepEqual(calls.map((call) => call.url), ['/auth/me', '/api/usage/summary?days=7'])
  assert.ok(calls.every((call) => call.init?.credentials === 'include'))
})

test('createSkill: POST + CSRF header + JSON body', async () => {
  globalThis.document = { cookie: 'csrf_token=tok-123' }
  const { fetchImpl, calls } = mockFetch(() => ({ status: 201, body: { id: 's1', name: 'x' } }))
  const api = new PlatformApiClient(fetchImpl)
  const skill = await api.createSkill({ name: 'x', visibility: 'private' })
  assert.equal((skill as { id: string }).id, 's1')
  assert.equal(calls[0].init?.method, 'POST')
  assert.equal((calls[0].init?.headers as Record<string, string>)['x-csrf-token'], 'tok-123')
  assert.equal((calls[0].init?.headers as Record<string, string>)['content-type'], 'application/json')
  assert.equal(calls[0].init?.body, JSON.stringify({ name: 'x', visibility: 'private' }))
  delete globalThis.document
})

test('uninstallSkill: DELETE without body', async () => {
  const { fetchImpl, calls } = mockFetch(() => ({ body: { ok: true } }))
  const api = new PlatformApiClient(fetchImpl)
  await api.uninstallSkill('s/1')
  assert.equal(calls[0].init?.method, 'DELETE')
  assert.match(calls[0].url, /^\/api\/skills\/s%2F1\/install$/)
  assert.equal(calls[0].init?.body, undefined)
})

test('error: non-2xx normalized to PlatformApiError with code', async () => {
  const { fetchImpl } = mockFetch(() => ({ status: 404, body: { error: 'not-found' } }))
  const api = new PlatformApiClient(fetchImpl)
  await assert.rejects(() => api.getSkill('x'), (err: unknown) => {
    assert.ok(err instanceof PlatformApiError)
    assert.equal((err as PlatformApiError).status, 404)
    assert.equal((err as PlatformApiError).code, 'not-found')
    return true
  })
})

test('error: network failure normalized to status 0', async () => {
  const { fetchImpl } = mockFetch(() => ({ throw: true }))
  const api = new PlatformApiClient(fetchImpl)
  await assert.rejects(() => api.listConnectors(), (err: unknown) => {
    assert.ok(err instanceof PlatformApiError)
    assert.equal((err as PlatformApiError).status, 0)
    return true
  })
})

test('identity: client never sends userId/tenantId in body/query', async () => {
  const { fetchImpl, calls } = mockFetch(() => ({ body: { records: [], total: 0 } }))
  const api = new PlatformApiClient(fetchImpl)
  await api.listMemory({ q: 'x', namespace: 'default' })
  await api.createMemory({ content: 'hello', namespace: 'default' })
  const all = JSON.stringify(calls)
  assert.ok(!/userId|tenantId|ownerId/.test(all), 'client must not transmit identity scoping fields')
})

test('personnel API sends scoped filters and CSRF-protected mutations without an actor identity', async () => {
  globalThis.document = { cookie: 'csrf_token=people-csrf' }
  try {
    const { fetchImpl, calls } = mockFetch(() => ({ body: { users: [], total: 0 } }))
    const api = new PlatformApiClient(fetchImpl)
    await api.listUsers({ q: '张 & 李', role: 'member', status: 'active', page: 2, pageSize: 20 })
    await api.createUser({ email: 'person@example.test', displayName: '张', role: 'member', password: 'a-password-123' })
    await api.updateUser('id/escaped', { status: 'disabled' })
    await api.resetUserPassword('id/escaped', 'replacement-123')
    await api.deleteUser('id/escaped')
    assert.equal(new URL(calls[0].url, 'http://test').searchParams.get('q'), '张 & 李')
    assert.equal(calls[2].url, '/api/admin/users/id%2Fescaped')
    assert.equal(calls[3].url, '/api/admin/users/id%2Fescaped/reset-password')
    for (const call of calls.slice(1)) assert.equal(call.init.headers['x-csrf-token'], 'people-csrf')
    assert.deepEqual(calls.slice(1).map((call) => call.init.method), ['POST', 'PATCH', 'POST', 'DELETE'])
    assert.equal(calls[4].url, '/api/admin/users/id%2Fescaped')
    assert.equal(calls[4].init.body, undefined)
    assert.doesNotMatch(JSON.stringify(calls), /tenantId|actor|ownerId/)
  } finally { delete globalThis.document }
})
