/**
 * Gateway memory extraction + internal channel token 测试。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractExplicitMemories, isSecretLike, isSensitiveContent, isMemoryAllowed } from '../src/memory-extraction.js'
import { issueRuntimeToken, resolveRuntimeToken, revokeRuntimeToken } from '../src/internal-channel.js'

test('gateway extract: explicit remember + secret rejection', () => {
  const ok = extractExplicitMemories('请记住:我的项目代号是 CMCC_MEMORY_07')
  assert.equal(ok.length, 1)
  assert.equal(ok[0]?.content, '我的项目代号是 CMCC_MEMORY_07')
  assert.deepEqual(extractExplicitMemories('请记住我的 api_key=sk-abcdefghijklmnop123456'), [])
})

test('gateway: isMemoryAllowed denies secret + sensitive', () => {
  assert.equal(isMemoryAllowed('password: hunter2'), false)
  assert.equal(isMemoryAllowed('我的诊断结果是高血压'), false)
  assert.equal(isMemoryAllowed('我的项目代号是 CMCC_MEMORY_07'), true)
  assert.equal(isSecretLike('token: abcdef'), true)
  assert.equal(isSensitiveContent('宗教信仰是 X'), true)
})

test('internal channel: issue/resolve/revoke per-user token', () => {
  const token = issueRuntimeToken('u1', 't1')
  const id = resolveRuntimeToken(token)
  assert.equal(id?.userId, 'u1')
  assert.equal(id?.tenantId, 't1')
  assert.equal(resolveRuntimeToken('bogus'), null)
  revokeRuntimeToken('u1')
  assert.equal(resolveRuntimeToken(token), null)
})

test('internal channel: rotation invalidates old token', () => {
  const t1 = issueRuntimeToken('u2', 't1')
  const t2 = issueRuntimeToken('u2', 't1')
  assert.notEqual(t1, t2)
  assert.equal(resolveRuntimeToken(t1), null)
  assert.equal(resolveRuntimeToken(t2)?.userId, 'u2')
  revokeRuntimeToken('u2')
})