/** Browser regression for the real UsersPanel with an isolated mock API. No business DB writes. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../', import.meta.url))
const bundle = await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {UsersPanel} from './packages/cmcc-platform-ui/src/client/panels/UsersPanel.tsx';
    createRoot(document.getElementById('root')).render(React.createElement(UsersPanel));`, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, format: 'esm', platform: 'browser',
  alias: { react: resolve(root, 'apps/portal/node_modules/react'), 'react-dom': resolve(root, 'apps/portal/node_modules/react-dom') },
})
const server = createServer((req, res) => {
  if (req.url === '/app.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundle.outputFiles[0].text); return }
  res.setHeader('content-type', 'text/html')
  res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><style>body{margin:0;font-family:system-ui}button:disabled{opacity:.45;cursor:not-allowed}dialog::backdrop{background:#0005}</style><div id="root" style="height:100vh"></div><script type="module" src="/app.js"></script></html>')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`
let browser
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) })
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  let viewerRole = 'tenant_admin'
  const adminId = '00000000-0000-0000-0000-000000000001'
  const rows = [
    { id: adminId, displayName: '租户管理员', email: 'admin@example.test', role: 'tenant_admin', status: 'active', createdAt: '2026-09-28T00:00:00Z' },
    { id: '00000000-0000-0000-0000-000000000002', displayName: '测试成员', email: 'member@example.test', role: 'member', status: 'active', createdAt: '2026-09-28T00:00:00Z' },
  ]
  let reset = false
  let failList = false
  let failDelete = false
  let deleteCalls = 0
  let listCalls = 0
  await page.route('**/auth/me', (route) => route.fulfill({ json: { userId: adminId, displayName: '租户管理员', role: viewerRole } }))
  await page.route('**/api/admin/users**', async (route) => {
    const req = route.request(), parsed = new URL(req.url())
    if (req.method() === 'GET') {
      listCalls++
      if (failList) return route.fulfill({ status: 500, json: { error: 'user-management-failed' } })
      const q = parsed.searchParams.get('q') ?? '', role = parsed.searchParams.get('role'), status = parsed.searchParams.get('status')
      const users = rows.filter((r) => (r.displayName.includes(q) || r.email.includes(q)) && (!role || r.role === role) && (!status || r.status === status))
      const currentPage = Number(parsed.searchParams.get('page') ?? 1)
      return route.fulfill({ json: { users: users.slice((currentPage - 1) * 20, currentPage * 20), total: users.length, page: currentPage, pageSize: 20 } })
    }
    assert.equal(req.headers()['x-csrf-token'], 'smoke-csrf')
    if (req.method() === 'DELETE') {
      deleteCalls++
      if (failDelete) return route.fulfill({ status: 500, json: { error: 'user-management-failed' } })
      const index = rows.findIndex((r) => parsed.pathname.endsWith(r.id))
      assert.ok(index >= 0 && rows[index].id !== adminId)
      rows.splice(index, 1)
      return route.fulfill({ json: { ok: true, runtimeStopped: true } })
    }
    const body = req.postDataJSON()
    if (parsed.pathname === '/api/admin/users') {
      const { password: _, ...input } = body
      const user = { ...input, id: '00000000-0000-0000-0000-000000000003', status: 'active', createdAt: '2026-09-28T00:00:00Z' }
      rows.push(user)
      return route.fulfill({ status: 201, json: { user, runtimeStopped: true } })
    }
    const user = rows.find((r) => parsed.pathname.includes(r.id))
    assert.ok(user)
    if (parsed.pathname.endsWith('/reset-password')) { reset = true; assert.equal(body.password, 'reset-password-123') }
    else Object.assign(user, body)
    return route.fulfill({ json: { user, runtimeStopped: true } })
  })
  await page.context().addCookies([{ name: 'csrf_token', value: 'smoke-csrf', url }])
  await page.goto(url)
  await page.getByRole('cell', { name: 'member@example.test', exact: true }).waitFor()
  assert.equal(await page.getByRole('row').filter({ hasText: 'admin@example.test' }).getByRole('button', { name: '停用' }).isDisabled(), true)
  assert.equal(await page.getByRole('row').filter({ hasText: 'admin@example.test' }).getByRole('button', { name: '删除', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: '添加人员' }).click()
  let dialog = page.getByRole('dialog')
  await dialog.getByLabel('姓名', { exact: true }).fill('新成员')
  await dialog.getByLabel('登录邮箱').fill('new@example.test')
  await dialog.getByLabel('初始密码').fill('new-password-123')
  await dialog.getByLabel('确认密码').fill('different-password')
  await dialog.getByRole('button', { name: '确认', exact: true }).click()
  await dialog.getByRole('alert').filter({ hasText: '不一致' }).waitFor()
  await dialog.getByLabel('确认密码').fill('new-password-123')
  await page.screenshot({ path: '/tmp/dsh-users-create.png', fullPage: true })
  await dialog.getByRole('button', { name: '确认', exact: true }).click()
  await page.getByRole('cell', { name: 'new@example.test', exact: true }).waitFor()
  let row = page.getByRole('row').filter({ hasText: 'new@example.test' })
  await row.getByRole('button', { name: '编辑', exact: true }).click()
  dialog = page.getByRole('dialog')
  await dialog.getByLabel('姓名', { exact: true }).fill('新成员已编辑')
  await dialog.getByLabel('角色', { exact: true }).selectOption('operator')
  await dialog.getByRole('button', { name: '确认', exact: true }).click()
  await page.getByRole('cell', { name: '新成员已编辑', exact: true }).waitFor()
  row = page.getByRole('row').filter({ hasText: 'new@example.test' })
  await row.getByRole('button', { name: '停用', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click()
  await row.getByRole('button', { name: '启用', exact: true }).waitFor()
  await row.getByRole('button', { name: '重置密码', exact: true }).click()
  dialog = page.getByRole('dialog')
  await dialog.getByLabel('新密码', { exact: true }).fill('reset-password-123')
  await dialog.getByLabel('确认密码', { exact: true }).fill('reset-password-123')
  await dialog.getByRole('button', { name: '确认', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(reset, true)
  // 删除有明确确认，可取消；服务端失败不会提前移除行，可在弹窗内重试。
  await row.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(deleteCalls, 0)
  await row.getByRole('button', { name: '删除', exact: true }).click()
  dialog = page.getByRole('dialog')
  await dialog.getByText(/历史工作区、会话和审计记录会保留/).waitFor()
  await page.screenshot({ path: '/tmp/dsh-users-delete.png', fullPage: true })
  failDelete = true
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click()
  await dialog.getByRole('alert').waitFor()
  assert.equal(rows.some((r) => r.email === 'new@example.test'), true)
  failDelete = false
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.getByText('共 2 人 · 第 1 页', { exact: true }).waitFor()
  assert.equal(await page.getByRole('cell', { name: 'new@example.test', exact: true }).count(), 0)
  await page.getByLabel('搜索人员').fill('nobody')
  await page.getByRole('button', { name: '查询', exact: true }).click()
  await page.getByText('没有符合条件的人员', { exact: true }).waitFor()
  await page.getByRole('button', { name: '重置', exact: true }).click()
  await page.getByRole('cell', { name: 'member@example.test', exact: true }).waitFor()
  // 删除末页唯一一人后自动返回有效页。
  for (let i = 0; i < 19; i++) rows.push({ id: `00000000-0000-0000-0000-${String(i + 10).padStart(12, '0')}`, displayName: `分页成员${i}`, email: `page${i}@example.test`, role: 'member', status: 'active', createdAt: '2026-09-28T00:00:00Z' })
  await page.getByRole('button', { name: '查询', exact: true }).click()
  await page.getByText('共 21 人 · 第 1 页', { exact: true }).waitFor()
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await page.getByText('共 21 人 · 第 2 页', { exact: true }).waitFor()
  await page.getByRole('row').filter({ hasText: 'page18@example.test' }).getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click()
  await page.getByText('共 20 人 · 第 1 页', { exact: true }).waitFor()
  await page.screenshot({ path: '/tmp/dsh-users-panel.png', fullPage: true })
  failList = true
  await page.getByRole('button', { name: '查询', exact: true }).click()
  await page.getByRole('alert').waitFor()
  failList = false
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await page.getByRole('cell', { name: 'member@example.test', exact: true }).waitFor()
  viewerRole = 'member'
  const before = listCalls
  await page.reload()
  await page.getByText('仅租户管理员可管理人员。', { exact: true }).waitFor()
  assert.equal(listCalls, before)
  assert.equal(await page.getByRole('button', { name: '添加人员' }).count(), 0)
  assert.deepEqual(errors, [])
  console.log('UsersPanel browser checks passed: create, edit/role, disable, password reset, deletion cancel/retry, last-page deletion, filters, error/retry, member denial.')
} finally {
  await browser?.close()
  await new Promise((resolve) => server.close(resolve))
}
