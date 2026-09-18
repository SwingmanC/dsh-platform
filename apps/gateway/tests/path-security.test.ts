import { describe, it } from 'node:test'
import assert from 'node:assert'
import path from 'node:path'
import { isWithinUserRoot, sanitizeWorkspaceName, userWorkspaceRoot } from '../src/platform.js'

describe('isWithinUserRoot', () => {
  const userId = 'user-1'
  const tenantId = 'tenant-1'
  const root = userWorkspaceRoot(userId, tenantId)

  it('根目录自身为合法', () => {
    assert.ok(isWithinUserRoot(userId, tenantId, root))
  })

  it('根下子目录为合法', () => {
    assert.ok(isWithinUserRoot(userId, tenantId, path.join(root, 'my-workspace')))
  })

  it('../ 跳出为非法', () => {
    assert.ok(!isWithinUserRoot(userId, tenantId, path.join(root, '..', '..', 'other-user')))
  })

  it('绝对路径跳出为非法', () => {
    assert.ok(!isWithinUserRoot(userId, tenantId, path.resolve('/etc/passwd')))
  })

  it('同前缀目录不可绕过', () => {
    assert.ok(!isWithinUserRoot(userId, tenantId, `${root}-sibling`))
  })

  it('跨租户路径为非法', () => {
    const otherTenantRoot = userWorkspaceRoot(userId, 'tenant-2')
    assert.ok(!isWithinUserRoot(userId, tenantId, path.join(otherTenantRoot, 'ws')))
  })
})

describe('sanitizeWorkspaceName', () => {
  it('合法名称通过', () => {
    assert.strictEqual(sanitizeWorkspaceName('my-workspace'), 'my-workspace')
    assert.strictEqual(sanitizeWorkspaceName('hello'), 'hello')
  })

  it('路径分隔符被拒绝', () => {
    assert.strictEqual(sanitizeWorkspaceName('../etc'), null)
    assert.strictEqual(sanitizeWorkspaceName('a/b'), null)
    assert.strictEqual(sanitizeWorkspaceName('a\\b'), null)
  })

  it('空字符串拒绝', () => {
    assert.strictEqual(sanitizeWorkspaceName(''), null)
    assert.strictEqual(sanitizeWorkspaceName('   '), null)
  })
})
