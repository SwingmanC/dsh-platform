/**
 * K-T3 单测:配置视图映射(无明文泄漏)+ 租户管理员守卫。纯函数,无 DB/服务依赖。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { embeddingConfigToView, isTenantAdminRole } from '../src/services/knowledge-service.js'
import { getCredentialStore } from '../src/credentials/credential-store.js'

const KEY = 'sk-embedding-secret-0001'

test('Case 7a: seal 产生 envelope,不含明文 key', () => {
  const envelope = getCredentialStore().seal(KEY)
  assert.ok(envelope.startsWith('v1.'))
  assert.ok(!envelope.includes(KEY))
})

test('Case 7b: GET 配置视图只含 hasKey/keyHint,无明文/无 envelope', () => {
  const view = embeddingConfigToView(
    {
      provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'embed-v1',
      dims: 1024, keyHint: '0001', lastTestAt: null, lastError: null,
    },
    true,
  )
  const serialized = JSON.stringify(view)
  assert.ok(!serialized.includes(KEY))
  assert.ok(!serialized.includes('api_key_envelope'))
  assert.ok(!serialized.includes('v1.'))
  assert.equal(view.hasKey, true)
  assert.equal(view.keyHint, '0001')
  // 无 key:hint 为 null
  const noKey = embeddingConfigToView({
    provider: 'openai-compatible', baseUrl: 'x', model: 'm', dims: 4, keyHint: '', lastTestAt: null, lastError: null,
  }, false)
  assert.equal(noKey.hasKey, false)
  assert.equal(noKey.keyHint, null)
})

test('Case 8: 权限守卫 — 仅 tenant_admin/operator 通过,member 被拒', () => {
  assert.equal(isTenantAdminRole('tenant_admin'), true)
  assert.equal(isTenantAdminRole('operator'), true)
  assert.equal(isTenantAdminRole('member'), false)
  assert.equal(isTenantAdminRole(''), false)
})
