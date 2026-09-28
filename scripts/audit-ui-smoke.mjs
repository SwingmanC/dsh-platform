/** Browser regression of the real AuditPanel with isolated API fixtures. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../', import.meta.url))
const bundle = await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {AuditPanel} from './packages/cmcc-platform-ui/src/client/panels/AuditPanel.tsx';
    createRoot(document.getElementById('root')).render(React.createElement(AuditPanel));`, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, format: 'esm', platform: 'browser',
  alias: { react: resolve(root, 'apps/portal/node_modules/react'), 'react-dom': resolve(root, 'apps/portal/node_modules/react-dom') },
})
const server = createServer((req, res) => {
  if (req.url === '/app.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundle.outputFiles[0].text); return }
  res.setHeader('content-type', 'text/html')
  res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><style>body{margin:0;font-family:system-ui}button:disabled{opacity:.45;cursor:not-allowed}</style><div id="root" style="height:100vh"></div><script type="module" src="/app.js"></script></html>')
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const url = `http://127.0.0.1:${server.address().port}`
let browser
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) })
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, timezoneId: 'Asia/Shanghai' })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  let role = 'tenant_admin', failList = false, failDetail = false, listCalls = 0
  const requests = []
  const base = { at: '2026-09-28T01:02:03.456000Z', actor: 'actor-a', actorName: '租户管理员', action: 'connector.credential.rotate',
    resourceType: 'connector', resourceId: '00000000-0000-0000-0000-000000000002', subject: null, result: 'SUCCESS',
    reasonCode: null, requestId: 'request-a', clientIp: '127.0.0.1', userAgent: 'Browser fixture', source: 'gateway', payload: { configured: true } }
  const rows = Array.from({ length: 21 }, (_, i) => ({ ...base, id: String(9007199254740993n + BigInt(i)) }))
  rows[1] = { ...rows[1], action: 'login', result: null, actorName: null, resourceType: null, resourceId: null, source: null, payload: null }
  await page.route('**/auth/me', (route) => route.fulfill({ json: { role, userId: 'actor-a', displayName: '租户管理员' } }))
  await page.route('**/api/audit/events**', async (route) => {
    const req = route.request(), parsed = new URL(req.url())
    requests.push(parsed)
    assert.equal(req.method(), 'GET')
    assert.equal(parsed.searchParams.has('tenantId'), false)
    assert.equal(req.postData(), null)
    if (parsed.pathname !== '/api/audit/events') {
      if (failDetail) return route.fulfill({ status: 500, json: { error: 'SQL unsafe secret' } })
      const item = rows.find((r) => parsed.pathname.endsWith(`/${r.id}`))
      return route.fulfill({ json: item })
    }
    listCalls++
    if (failList) return route.fulfill({ status: 500, json: { error: 'SQL unsafe secret' } })
    const actorName = parsed.searchParams.get('actorName') ?? '', action = parsed.searchParams.get('action'), result = parsed.searchParams.get('result')
    const items = rows.filter((r) => (!actorName || (r.actorName ?? '').includes(actorName)) && (!action || r.action === action) && (!result || r.result === result))
    const currentPage = Number(parsed.searchParams.get('page') ?? 1), pageSize = Number(parsed.searchParams.get('pageSize') ?? 20)
    return route.fulfill({ json: { items: items.slice((currentPage - 1) * pageSize, currentPage * pageSize), total: items.length, page: currentPage, pageSize } })
  })
  await page.goto(url)
  await page.getByText('共 21 条 · 第 1 / 2 页', { exact: true }).waitFor()
  assert.ok(await page.getByRole('cell', { name: '未记录', exact: true }).count() > 0)
  await page.screenshot({ path: '/tmp/dsh-audit-panel.png', fullPage: true })
  await page.getByRole('button', { name: '查看', exact: true }).first().click()
  let dialog = page.getByRole('dialog')
  await dialog.getByText('9007199254740993', { exact: true }).waitFor()
  await dialog.getByText('request-a', { exact: true }).waitFor()
  assert.match(await dialog.textContent(), /configured/)
  await page.screenshot({ path: '/tmp/dsh-audit-detail.png', fullPage: true })
  await page.keyboard.press('Tab')
  assert.equal(await page.getByRole('button', { name: '关闭', exact: true }).evaluate((el) => el === document.activeElement), true)
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(await page.getByRole('button', { name: '查看', exact: true }).first().evaluate((el) => el === document.activeElement), true)
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await page.getByText('共 21 条 · 第 2 / 2 页', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '下一页', exact: true }).isDisabled(), true)
  await page.getByLabel('每页条数').selectOption('50')
  await page.getByText('共 21 条 · 第 1 / 1 页', { exact: true }).waitFor()
  await page.getByLabel('操作人姓名').fill('不存在')
  await page.getByRole('button', { name: '查询', exact: true }).click()
  await page.getByText('没有符合条件的审计记录', { exact: true }).waitFor()
  await page.getByRole('button', { name: '重置', exact: true }).click()
  await page.getByText('共 21 条 · 第 1 / 1 页', { exact: true }).waitFor()
  await page.getByLabel('开始时间').fill('2026-09-28T08:00')
  await page.getByLabel('结束时间').fill('2026-09-28T07:00')
  const beforeInvalid = listCalls
  await page.getByRole('button', { name: '查询', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '开始时间' }).waitFor()
  assert.equal(listCalls, beforeInvalid)
  await page.getByLabel('结束时间').fill('2026-09-28T10:00')
  await page.getByLabel('操作类型').selectOption('connector.credential.rotate')
  await page.getByLabel('操作结果').selectOption('SUCCESS')
  await page.getByRole('button', { name: '查询', exact: true }).click()
  await page.getByText('共 20 条 · 第 1 / 1 页', { exact: true }).waitFor()
  assert.equal(requests.at(-1).searchParams.get('from'), '2026-09-28T00:00:00.000Z')
  failDetail = true
  await page.getByRole('button', { name: '查看', exact: true }).first().click()
  dialog = page.getByRole('dialog')
  await dialog.getByRole('alert').waitFor()
  assert.doesNotMatch(await dialog.textContent(), /SQL|unsafe|secret/)
  failDetail = false
  await dialog.getByRole('button', { name: '重试', exact: true }).click()
  await dialog.getByText('request-a', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  failList = true
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await page.getByRole('alert').waitFor()
  assert.equal(await page.getByRole('table').count(), 0)
  failList = false
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await page.getByRole('table').waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: '/tmp/dsh-audit-mobile.png', fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  role = 'member'
  const beforeMember = listCalls
  await page.reload()
  await page.getByText('仅租户管理员可查看审计日志。', { exact: true }).waitFor()
  assert.equal(listCalls, beforeMember)
  assert.equal(await page.getByRole('table').count(), 0)
  assert.deepEqual(errors, [])
  console.log('AuditPanel browser checks passed: filters, timezone, paging, bigint detail, legacy fields, keyboard drawer, empty/error/retry, mobile layout, member denial.')
} finally {
  await browser?.close()
  await new Promise((done) => server.close(done))
}
