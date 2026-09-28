import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PlatformApiClient, PlatformApiError } from '../src/client/platform-api.ts'
import { auditErrorMessage, auditTime } from '../src/client/models/audit.ts'

test('audit client encodes filters and bigint IDs without supplying a tenant or actor identity', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const api = new PlatformApiClient((async (input, init) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify({ items: [], total: 0, page: 1, pageSize: 20 }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch)
  await api.listAuditEvents({ actorName: '张 & 李', action: 'user.create', result: 'SUCCESS', from: '2026-09-28T00:00:00.000Z', page: 2, pageSize: 50 })
  await api.getAuditEvent('9007199254740993')
  assert.equal(new URL(calls[0]!.url, 'http://test').searchParams.get('actorName'), '张 & 李')
  assert.equal(calls[1]!.url, '/api/audit/events/9007199254740993')
  assert.ok(calls.every((v) => v.init?.credentials === 'include' && v.init?.body === undefined))
  assert.doesNotMatch(JSON.stringify(calls), /tenantId|ownerId|userId/)
})

test('audit errors are readable and never expose raw database details', () => {
  assert.match(auditErrorMessage(new PlatformApiError(401, 'unauthenticated')), /重新登录/)
  assert.match(auditErrorMessage(new PlatformApiError(404, 'not-found')), /无权/)
  assert.match(auditErrorMessage(new PlatformApiError(400, 'invalid-audit-query')), /时间范围/)
  assert.match(auditErrorMessage(new PlatformApiError(0, 'network-error')), /网络连接失败/)
  assert.doesNotMatch(auditErrorMessage(new PlatformApiError(500, 'SQL secret password')), /SQL|secret|password/)
  assert.equal(auditTime('invalid'), 'invalid')
})
