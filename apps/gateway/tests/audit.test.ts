import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import type { FastifyRequest } from 'fastify'
import type { AuthenticatedPrincipal, AuditLogItem, TenantContext } from '@dsh-platform/shared'
import { AuditRepository, auditRepository, auditWhere, type StoredAuditEvent } from '../src/repositories/audit-repository.js'
import { AuditService, auditService, auditMutation, auditRequestContext } from '../src/services/audit-service.js'
import { sanitizePayload } from '../src/services/audit-sanitize.js'
import { registerAuditHooks } from '../src/audit-hooks.js'
import { registerAuditRoutes, parseAuditQuery } from '../src/routes/audit.js'
import { registerPlatformAuthentication, isPlatformApiPath } from '../src/auth/platform-auth.js'
import { SessionService } from '../src/auth/session.js'
import { registerAuthRoutes } from '../src/routes/auth.js'
import type { SessionData, SessionStore } from '../src/auth/session-store.js'
import { config } from '../src/config.js'
import { pool } from '../src/db.js'
import { MCPService } from '../src/services/mcp-service.js'
import { mcpRepository } from '../src/repositories/mcp-repository.js'
import { hashPassword } from '../src/auth/password.js'

const ctx: TenantContext = { tenantId: 'tenant-a', userId: 'actor-a', role: 'tenant_admin', requestId: 'request', platformSessionId: '', deviceId: 'device' }
const actor: AuthenticatedPrincipal = { ...ctx, displayName: '管理员甲', sessionId: 'sid', authVersion: 0 }
const row = (id: string): AuditLogItem => ({ id, at: '2026-09-28T00:00:00.000Z', actor: actor.userId, actorName: actor.displayName,
  action: 'user.create', resourceType: 'user', resourceId: 'target', subject: null, result: 'SUCCESS', reasonCode: null,
  requestId: 'r', clientIp: null, userAgent: null, source: 'gateway', payload: null })

function sessionFixture() {
  const values = new Map<string, SessionData>()
  const store: SessionStore = { kind: 'memory', create: async (v) => { const id = `sid-${values.size}`; values.set(id, v); return id },
    get: async (id) => values.get(id) ?? null, destroy: async (id) => { values.delete(id) }, touch: async () => {},
    close: async () => {}, rotate: async () => { throw new Error('unused') }, revokeByUser: async () => {} }
  const add = (id: string, p: AuthenticatedPrincipal) => values.set(id, { ...p, csrfSecret: 'csrf', issuedAt: 1, lastSeen: 1, revocationEpoch: 0 })
  add('admin', actor); add('member', { ...actor, userId: 'member', role: 'member' })
  const sessions = new SessionService(store, async (id) => ({ ...actor, userId: id, role: id === 'member' ? 'member' : 'tenant_admin', status: 'active', authVersion: 0 }))
  return { sessions, add }
}

async function capture(run: (events: StoredAuditEvent[]) => Promise<void>) {
  const events: StoredAuditEvent[] = []
  const original = auditRepository.insert
  auditRepository.insert = async (event) => { events.push(event) }
  try { await run(events) } finally { auditRepository.insert = original }
}

test('payload is whitelisted, recursively redacted, bounded and remains valid JSON', () => {
  const circular: Record<string, unknown> = {}; circular.self = circular
  const result = sanitizePayload({ content: 'private document', password: 'plaintext', rawError: 'SQL credential',
    changedFields: [{ API_KEY: 'sensitive-key', nested: [{ authorization: 'Bearer secret', label: 'safe' }] }],
    role: circular, status: 'active' })
  const serialized = JSON.stringify(result)
  assert.doesNotMatch(serialized, /sensitive-key|Bearer secret|private document|plaintext|SQL credential/)
  assert.match(serialized, /REDACTED/); assert.match(serialized, /CIRCULAR/)
  assert.ok(Buffer.byteLength(JSON.stringify(sanitizePayload({ changedFields: Array(30).fill('中'.repeat(300)) }))) <= 4096)
  assert.deepEqual(sanitizePayload({ rawError: 'unsafe' }), null)
})

test('write failure never rejects business or exposes raw SQL/credentials; timeout bounds request waiting', async () => {
  const logs: unknown[] = []
  const service = new AuditService({ insert: async () => { throw new Error('secret plaintext bound in SQL') } }, (v) => logs.push(v))
  await service.write({ ctx, action: 'user.create', payload: { password: 'secret' } })
  assert.equal(service.failures, 1); assert.doesNotMatch(JSON.stringify(logs), /secret|plaintext|SQL/)
  const stalled = new AuditService({ insert: () => new Promise(() => {}) }, () => {})
  const start = Date.now()
  await stalled.write({ ctx, action: 'user.create' })
  assert.ok(Date.now() - start < 2500); assert.equal(stalled.failures, 1)
  await Promise.all(Array.from({ length: 12 }, () => stalled.write({ ctx, action: 'user.create' })))
  assert.equal(stalled.failures, 13)
})

test('query rejects client scope, malformed dates, arrays, SQL-like filters and unbounded pagination', () => {
  for (const q of [{ tenantId: 'other' }, { actor: ['a'] }, { result: 'SUCCESS OR 1=1' }, { action: "login' OR 1=1" },
    { pageSize: 101 }, { page: 0 }, { page: '1e3' }, { page: {} }, { from: '2026-02-30T00:00:00Z' },
    { from: '2026-09-28T00:00:00Z', to: '2026-09-27T00:00:00Z' }]) assert.throws(() => parseAuditQuery(q))
  assert.deepEqual(parseAuditQuery({ result: 'DENIED', page: '2', from: '2026-09-28T00:00:00Z' }),
    { result: 'DENIED', from: '2026-09-28T00:00:00.000Z', page: 2, pageSize: 20 })
  const where = auditWhere('tenant-a', { actorName: "%' OR 1=1", result: 'ERROR' })
  assert.match(where.sql, /^tenant_id = \?/); assert.doesNotMatch(where.sql, /OR 1=1/)
  assert.deepEqual(where.params, ['tenant-a', 'ERROR', "%' OR 1=1"])
  assert.throws(() => auditWhere('', {}), /scope-required/)
})

test('repository scopes count/list/detail consistently and masks historical payload', async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const repository = new AuditRepository(async () => 1, async <T>(sql: string, params = []) => {
    queries.push({ sql, params })
    return (sql.includes('COUNT(*)') ? [{ total: 1 }] : [{ ...row('9007199254740993'), result: null, source: null,
      payload: '{"password":"historical-secret","content":"private","role":"member"}' }]) as T[]
  })
  const data = await repository.list('tenant-a', { page: 2, pageSize: 20, action: 'user.create' })
  assert.equal(data.items[0]?.id, '9007199254740993'); assert.equal(data.items[0]?.result, null)
  assert.doesNotMatch(JSON.stringify(data), /historical-secret|private/)
  await repository.find('tenant-a', '9007199254740993')
  assert.ok(queries.every((q) => /tenant_id = \?/.test(q.sql) && q.params[0] === 'tenant-a'))
  assert.match(queries[1]!.sql, /ORDER BY at DESC, id DESC/)
  assert.deepEqual(queries[1]!.params.slice(-2), [20, 20])
})

test('actual authentication hook protects audit routes on both hosts; roles and forged tenant filters cannot widen scope', async () => {
  const { sessions } = sessionFixture()
  const calls: unknown[][] = []
  const app = Fastify()
  await app.register(cookie)
  registerPlatformAuthentication(app, sessions)
  registerAuditRoutes(app, {
    list: async (tenant, query) => { calls.push([tenant, query]); return { items: [row('1')], total: 1, page: 1, pageSize: 20 } },
    find: async (tenant, id) => { calls.push([tenant, id]); return id === '1' ? row(id) : null },
  })
  try {
    assert.equal(isPlatformApiPath('/api/audit/events/9007199254740993'), true)
    assert.equal(isPlatformApiPath('/api/session/list'), false)
    for (const host of [config.platform.authority, config.dsh.uiAuthority]) {
      assert.equal((await app.inject({ url: '/api/audit/events', headers: { host } })).statusCode, 401)
      assert.equal((await app.inject({ url: '/api/audit/events', headers: { host, cookie: `${config.session.cookieName}=member` } })).statusCode, 404)
      const headers = { host, cookie: `${config.session.cookieName}=admin` }
      assert.equal((await app.inject({ url: '/api/audit/events', headers })).statusCode, 200)
      assert.equal((await app.inject({ url: '/api/audit/events?tenantId=tenant-b', headers })).statusCode, 400)
      assert.equal((await app.inject({ url: '/api/audit/events/1', headers })).statusCode, 200)
      assert.equal((await app.inject({ url: '/api/audit/events/2', headers })).statusCode, 404)
      assert.equal((await app.inject({ url: '/api/audit/events/18446744073709551616', headers })).statusCode, 404)
    }
    assert.ok(calls.every((v) => v[0] === 'tenant-a'))
  } finally { await app.close() }
})

test('concurrent request context preserves actor snapshots, request IDs and ignores spoofed client identity/IP', async () => capture(async (events) => {
  const app = Fastify({ requestIdHeader: 'x-test-request-id' })
  registerAuditHooks(app)
  app.addHook('preHandler', async (req) => { req.principal = { ...actor, userId: req.id, displayName: `name-${req.id}`, tenantId: req.id } })
  app.post('/api/skills', async (req) => {
    await new Promise((resolve) => setTimeout(resolve, req.id === 'a' ? 20 : 1))
    await auditService.write({ action: 'skill.create', resourceId: 'resource' })
    return { ok: true }
  })
  try {
    await Promise.all(['a', 'b'].map((id) => app.inject({ method: 'POST', url: '/api/skills', headers: { 'x-test-request-id': id, 'x-forwarded-for': '203.0.113.99' },
      remoteAddress: id === 'a' ? '127.0.0.2' : '127.0.0.3', payload: { tenantId: 'forged', userId: 'forged' },
    })))
    assert.equal(events.length, 2)
    for (const event of events) {
      assert.equal(event.tenantId, event.actor); assert.equal(event.actorName, `name-${event.actor}`)
      assert.equal(event.requestId, event.actor); assert.notEqual(event.clientIp, '203.0.113.99')
      assert.equal(event.source, 'gateway')
    }
  } finally { await app.close() }
}))

test('business false/error results and failed sync are distinct; early validation/CSRF denial is recorded once', async () => capture(async (events) => {
  const app = Fastify()
  registerAuditHooks(app)
  app.addHook('preHandler', async (req, reply) => {
    req.principal = actor
    if (req.headers['x-deny']) return reply.code(403).send({ error: 'csrf-failed' })
  })
  app.post('/api/skills', async (req, reply) => {
    if (req.headers['x-invalid']) return reply.code(400).send({ error: 'name-required' })
    if (req.headers['x-error']) return auditMutation(ctx, 'skill.create', 'resource', async () => { throw new Error('SQL raw-secret') })
    if (req.headers['x-false']) { await auditMutation(ctx, 'skill.create', 'resource', async () => false); return { ok: true } }
    await auditMutation(ctx, 'skill.create', 'resource', async () => true)
    throw new Error('projection raw-secret')
  })
  try {
    for (const header of ['x-deny', 'x-invalid', 'x-error', 'x-false', 'x-sync']) await app.inject({ method: 'POST', url: '/api/skills', headers: { [header]: '1' } })
    assert.deepEqual(events.map((e) => [e.action, e.result]), [
      ['skill.create', 'DENIED'], ['skill.create', 'DENIED'], ['skill.create', 'ERROR'], ['skill.create', 'DENIED'],
      ['skill.create', 'SUCCESS'], ['projection.sync', 'ERROR'],
    ])
    assert.doesNotMatch(JSON.stringify(events), /raw-secret|SQL/)
  } finally { await app.close() }
}))

test('trusted login identity is explicit before a session principal exists; system callbacks do not inherit stale request metadata', async () => {
  const events: StoredAuditEvent[] = []
  const service = new AuditService({ insert: async (event) => { events.push(event) } })
  const request = { id: 'login-request', url: '/auth/login', ip: '127.0.0.1', headers: { 'user-agent': 'fixture' } } as FastifyRequest
  await auditRequestContext.run({ request, actions: new Map() }, async () => {
    await service.write({ action: 'login.success', identity: actor })
    await service.write({ action: 'runtime.dead', identity: actor, source: 'system' })
  })
  assert.equal(events[0]?.tenantId, actor.tenantId); assert.equal(events[0]?.actor, actor.userId)
  assert.equal(events[0]?.actorName, actor.displayName); assert.equal(events[0]?.requestId, 'login-request')
  assert.equal(events[1]?.requestId, null); assert.equal(events[1]?.clientIp, null)
})

test('actual login/logout writes tenant and actor even before authentication context; unknown accounts stay platform-scoped', async () => capture(async (events) => {
  const { sessions } = sessionFixture()
  const hash = await hashPassword('audit-fixture-password')
  const originalQuery = pool.query
  pool.query = (async (_sql: unknown, params: unknown[]) => {
    const email = params[0]
    const users = email === 'known@audit.test' || email === 'disabled@audit.test' ? [{ id: actor.userId, tenantId: actor.tenantId,
      displayName: actor.displayName, role: actor.role, status: email === 'disabled@audit.test' ? 'disabled' : 'active', passwordHash: hash, authVersion: 0 }] : []
    return [users, []]
  }) as typeof pool.query
  const app = Fastify()
  await app.register(cookie)
  registerAuditHooks(app)
  registerAuthRoutes(app, sessions)
  try {
    const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'known@audit.test', password: 'audit-fixture-password' } })
    assert.equal(response.statusCode, 200)
    const cookies = response.cookies.map((c) => `${c.name}=${c.value}`).join('; ')
    const csrf = response.cookies.find((c) => c.name === config.session.csrfCookieName)!.value
    assert.equal((await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: cookies, 'x-csrf-token': csrf } })).statusCode, 302)
    for (const [email, password, code] of [['known@audit.test', 'wrong', 401], ['unknown@audit.test', 'wrong', 401], ['disabled@audit.test', 'audit-fixture-password', 403]] as const) {
      assert.equal((await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } })).statusCode, code)
    }
    assert.deepEqual(events.map((e) => [e.action, e.tenantId, e.actor, e.result]), [
      ['login.success', actor.tenantId, actor.userId, 'SUCCESS'], ['logout', actor.tenantId, actor.userId, 'SUCCESS'],
      ['login.failed', actor.tenantId, actor.userId, 'DENIED'], ['login.failed', null, null, 'DENIED'],
      ['login.failed', actor.tenantId, actor.userId, 'DENIED'],
    ])
    assert.doesNotMatch(JSON.stringify(events), /audit-fixture-password|argon2/)
  } finally { pool.query = originalQuery; await app.close() }
}))

test('actual MCP approval preserves its successful mutation when subsequent projection rebuild fails', async () => capture(async (events) => {
  const originalFind = mcpRepository.findRawById, originalApprove = mcpRepository.approve
  const service = new MCPService()
  let committed = false
  mcpRepository.findRawById = async () => ({ id: 'connector', tenantId: ctx.tenantId, transport: 'stdio' }) as Awaited<ReturnType<typeof originalFind>>
  mcpRepository.approve = async () => { committed = true; return true }
  service.rebuildProjectionsForConnector = async () => { throw new Error('private projection path with credential') }
  try {
    await assert.rejects(() => service.approve(ctx, 'connector'))
    assert.equal(committed, true)
    assert.deepEqual(events.map((e) => [e.action, e.result, e.resourceId]), [
      ['connector.approve', 'SUCCESS', 'connector'], ['projection.sync', 'ERROR', 'connector'],
    ])
    assert.doesNotMatch(JSON.stringify(events), /private projection path|credential/)
    await assert.rejects(() => service.approve({ ...ctx, role: 'member' }, 'connector'), /forbidden/)
    assert.equal(events.at(-1)?.result, 'DENIED')
  } finally { mcpRepository.findRawById = originalFind; mcpRepository.approve = originalApprove }
}))
