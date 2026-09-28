import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PlatformApiError } from '../src/client/platform-api.ts'
import { userErrorMessage } from '../src/client/models/users.ts'

test('personnel errors describe actionable failures without exposing SQL or raw server messages', () => {
  assert.match(userErrorMessage(new PlatformApiError(401, 'unauthenticated')), /重新登录/)
  assert.match(userErrorMessage(new PlatformApiError(409, 'email-unavailable')), /邮箱不可用/)
  assert.match(userErrorMessage(new PlatformApiError(409, 'cannot-disable-or-demote-self')), /不能停用自己/)
  assert.match(userErrorMessage(new PlatformApiError(429, 'too-many')), /过于频繁/)
  assert.doesNotMatch(userErrorMessage(new PlatformApiError(500, 'SQL: secret')), /SQL|secret/)
})
