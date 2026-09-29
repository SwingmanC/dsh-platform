import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PlatformApiError } from '../src/client/platform-api.ts'
import { usageErrorMessage } from '../src/client/models/usage-error.ts'

test('usage error message distinguishes auth, network and server failures', () => {
  assert.match(usageErrorMessage(new PlatformApiError(401, 'unauthenticated')), /重新登录/)
  assert.match(usageErrorMessage(new PlatformApiError(404, 'not-found')), /租户管理员/)
  assert.match(usageErrorMessage(new PlatformApiError(0, 'network-error')), /网络连接失败/)
  assert.match(usageErrorMessage(new PlatformApiError(500, 'internal-error')), /统计服务暂时不可用/)
  assert.doesNotMatch(usageErrorMessage(new PlatformApiError(500, 'ER_WRONG_FIELD_WITH_GROUP')), /ER_WRONG/)
})
