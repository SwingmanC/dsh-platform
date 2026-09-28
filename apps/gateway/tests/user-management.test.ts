import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import type { AuthenticatedPrincipal, ManagedUser } from '@dsh-platform/shared'
import { SessionService } from '../src/auth/session.js'
import type { SessionData, SessionStore } from '../src/auth/session-store.js'
import type { UserAuthState } from '../src/auth/user-state.js'
import { config } from '../src/config.js'
import { registerPlatformAuthentication, isPlatformApiPath } from '../src/auth/platform-auth.js'
import { registerUserRoutes } from '../src/routes/users.js'
import { UserService } from '../src/services/user-service.js'
import { createUserInput, updateUserInput, userListQuery, UserManagementError } from '../src/services/user-validation.js'
import { verifyPassword } from '../src/auth/password.js'

const actor: AuthenticatedPrincipal = { userId: '00000000-0000-0000-0000-000000000001', tenantId: 'tenant-a',
  displayName: 'Admin', role: 'tenant_admin', deviceId: 'device', sessionId: 'sid', authVersion: 0 }
const user: ManagedUser = { id: '00000000-0000-0000-0000-000000000002', email: 'user@example.test', displayName: 'Member',
  role: 'member', status: 'active', createdAt: '2026-09-28T00:00:00.000Z' }

function storeFixture() {
  const values = new Map<string, SessionData>()
  const store: SessionStore = {
    kind: 'memory', create: async (data) => { const sid = `sid-${values.size}`; values.set(sid, data); return sid },
    get: async (sid) => values.get(sid) ?? null, touch: async () => {}, destroy: async (sid) => { values.delete(sid) },
    close: async () => {}, rotate: async () => { throw new Error('unused') }, revokeByUser: async () => {},
  }
  values.set('sid', { ...actor, csrfSecret: 'csrf-valid', issuedAt: 1, lastSeen: 1, revocationEpoch: 0 })
  return { store, values }
}

test('validation normalizes email, rejects injected identity and unsupported roles, and bounds paging/password', () => {
  const base = { email: ' User@Example.test ', displayName: ' 成员 ', role: 'member', password: 'safe-password-42' }
  assert.deepEqual(createUserInput(base), { ...base, email: 'user@example.test', displayName: '成员' })
  for (const v of [{ ...base, tenantId: 'tenant-b' }, { ...base, role: 'PLATFORM_ADMIN' }, { ...base, password: '123456' }, { ...base, password: ' '.repeat(12) }]) {
    assert.throws(() => createUserInput(v), UserManagementError)
  }
  for (const v of [{}, { status: 'deleted' }, { authVersion: 0 }, { role: ['member'] }]) assert.throws(() => updateUserInput(v), UserManagementError)
  for (const v of [{ page: 0 }, { pageSize: 101 }, { page: ['1'] }, { role: ['member'] }, { page: '1 OR 1=1' }, { tenantId: 'other' }]) assert.throws(() => userListQuery(v), UserManagementError)
})

test('session reads reject disabled, moved, changed-role and old-version accounts through the shared SessionStore validation path', async () => {
  for (const patch of [{ status: 'disabled' }, { tenantId: 'other' }, { role: 'member' }, { authVersion: 1 }]) {
    const { store, values } = storeFixture()
    const state = { ...actor, status: 'active', ...patch } as UserAuthState
    const session = new SessionService(store, async () => state)
    assert.equal(await session.readPrincipal({ cookies: { [config.session.cookieName]: 'sid' }, headers: {} }), null)
    assert.equal(values.size, 0)
  }
  const { store } = storeFixture()
  const session = new SessionService(store, async () => ({ ...actor, status: 'active', authVersion: 0, displayName: 'New name' }))
  const request = { cookies: { [config.session.cookieName]: 'sid' }, headers: {} }
  assert.equal((await session.readPrincipal(request))?.principal.displayName, 'New name')
  const unavailable = new SessionService(store, async () => { throw new Error('db-offline') })
  await assert.rejects(() => unavailable.readPrincipal(request), /db-offline/)
  // 逻辑删除后身份加载器不再返回该用户，即使 Cookie 仍在也不能继续使用。
  const deleted = new SessionService(store, async () => null)
  assert.equal(await deleted.readPrincipal(request), null)
})

test('service hashes credentials and audits metadata, with honest runtime cleanup status', async () => {
  const auditEvents: unknown[] = []
  let savedHash = ''
  let stopped = ''
  const service = new UserService({
    list: async () => ({ users: [user], total: 1, page: 1, pageSize: 20 }),
    create: async (_actor, input, hash) => { savedHash = hash; assert.ok(!('password' in input)); return user },
    update: async (_actor, _id, _input, hash) => { savedHash = hash ?? ''; return { user, securityChanged: true, changedFields: ['password'] } },
    remove: async () => {},
  }, async (id) => { stopped = id; throw new Error('process cleanup failed') }, { write: async (event) => { auditEvents.push(event) } })
  await service.create(actor, { email: user.email, displayName: user.displayName, role: user.role, password: 'safe-password-42' })
  assert.equal(await verifyPassword(savedHash, 'safe-password-42'), true)
  const response = await service.resetPassword(actor, user.id, { password: 'another-password-42' })
  assert.equal(await verifyPassword(savedHash, 'another-password-42'), true)
  assert.equal(response.runtimeStopped, false)
  assert.equal(stopped, user.id)
  assert.doesNotMatch(JSON.stringify([response, auditEvents]), /safe-password|another-password|argon2|password_hash/)
  await assert.rejects(() => service.list({ ...actor, role: 'operator' }, {}), (e: unknown) => e instanceof UserManagementError && e.statusCode === 404)
  const deletion = await service.remove(actor, user.id)
  assert.deepEqual(deletion, { ok: true, runtimeStopped: false })
  assert.equal(stopped, user.id)
  assert.deepEqual(auditEvents.at(-1), { ctx: { tenantId: actor.tenantId, userId: actor.userId, role: actor.role,
    requestId: '', platformSessionId: '', deviceId: actor.deviceId }, action: 'user.delete', subject: user.id, payload: { runtimeStopped: false } })
  await assert.rejects(() => service.remove({ ...actor, role: 'member' }, user.id), /not-found/)
})

test('actual platform auth hook protects user routes on both authorities, including CSRF and role checks', async () => {
  const { store } = storeFixture()
  let current: UserAuthState = { ...actor, authVersion: 0, status: 'active' }
  const sessions = new SessionService(store, async () => current)
  let creates = 0
  let deletes = 0
  const service = new UserService({
    list: async (tenantId) => { assert.equal(tenantId, actor.tenantId); return { users: [user], total: 1, page: 1, pageSize: 20 } },
    create: async () => { creates++; return user },
    update: async () => { throw new UserManagementError(404, 'not-found') },
    remove: async (_actor, id) => { assert.equal(id, user.id); deletes++ },
  }, async () => {}, { write: async () => {} })
  const app = Fastify()
  await app.register(cookie)
  registerPlatformAuthentication(app, sessions)
  registerUserRoutes(app, service)
  try {
    assert.equal(isPlatformApiPath(`/api/admin/users/${user.id}/reset-password`), true)
    assert.equal(isPlatformApiPath('/api/skills/list'), false)
    assert.equal(isPlatformApiPath('/api/admin/users/not-a-uuid'), false)
    for (const host of [config.platform.authority, config.dsh.uiAuthority]) {
      assert.equal((await app.inject({ url: '/api/admin/users', headers: { host } })).statusCode, 401)
      const headers = { host, cookie: `${config.session.cookieName}=sid` }
      assert.equal((await app.inject({ url: '/api/admin/users', headers })).statusCode, 200)
      const payload = { email: user.email, displayName: 'New user', password: 'safe-password-42', role: 'member' }
      assert.equal((await app.inject({ method: 'POST', url: '/api/admin/users', headers, payload })).statusCode, 403)
      assert.equal((await app.inject({ method: 'POST', url: '/api/admin/users', headers: { ...headers, 'x-csrf-token': 'csrf-valid' }, payload })).statusCode, 201)
      assert.equal((await app.inject({ method: 'PATCH', url: `/api/admin/users/${user.id}`, headers: { ...headers, 'x-csrf-token': 'csrf-valid' }, payload: { displayName: 'Other' } })).statusCode, 404)
      assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/users/${user.id}`, headers })).statusCode, 403)
      const deletion = await app.inject({ method: 'DELETE', url: `/api/admin/users/${user.id}`, headers: { ...headers, 'x-csrf-token': 'csrf-valid' } })
      assert.equal(deletion.statusCode, 200)
      assert.deepEqual(deletion.json(), { ok: true, runtimeStopped: true })
    }
    assert.equal(creates, 2)
    assert.equal(deletes, 2)
    current = { ...current, role: 'member' }
    // An old admin sid is rejected rather than retaining its management role.
    assert.equal((await app.inject({ url: '/api/admin/users', headers: { cookie: `${config.session.cookieName}=sid` } })).statusCode, 401)
    const memberData = { ...actor, role: 'member' as const, csrfSecret: 'x', issuedAt: 1, lastSeen: 1, revocationEpoch: 0 }
    const memberSid = await store.create(memberData, 10000)
    assert.equal((await app.inject({ url: '/api/admin/users', headers: { cookie: `${config.session.cookieName}=${memberSid}` } })).statusCode, 404)
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/users/${user.id}`, headers: { cookie: `${config.session.cookieName}=${memberSid}`, 'x-csrf-token': 'x' } })).statusCode, 404)
    assert.equal(deletes, 2)
  } finally { await app.close() }
})
