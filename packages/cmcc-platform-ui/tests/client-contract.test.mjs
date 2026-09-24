/**
 * cmcc-platform-ui client bundle 契约测试(无浏览器)。
 *
 * 1. 评估 `lib/client.js`,捕获 `window.__ModuleLoader__.load({ id, factory })`。
 * 2. mock module table materialize factory(只暴露官方 baseline externals)。
 * 3. fake ctx 调 `apply`,断言公共 Panel、管理员用量入口 + 品牌槽的注册参数。
 * 4. 断言 `cmcc.smoke` 不再注册。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = resolve(here, '../lib/client.js')

const EXPECTED = [
  { id: 'cmcc.skills', label: '技能广场', order: 100 },
  { id: 'cmcc.knowledge', label: '知识中心', order: 110 },
  { id: 'cmcc.mcp', label: 'MCP 服务', order: 120 },
  { id: 'cmcc.memory', label: '我的记忆', order: 130 },
  { id: 'cmcc.usage', label: '用量统计', order: 140 },
]

function loadRegistration(path) {
  const code = readFileSync(path, 'utf8')
  let captured = null
  const sandboxWindow = { __ModuleLoader__: { load(reg) { captured = reg } } }
  const evaluate = new Function('window', 'document', code)
  evaluate(sandboxWindow, undefined)
  assert.ok(captured, 'bundle did not call window.__ModuleLoader__.load')
  return captured
}

function mockRequire(spec) {
  if (spec === 'react' || spec === 'react/jsx-runtime') {
    return { jsx() {}, jsxs() {}, Fragment: {}, createElement() {}, useState() {}, useEffect() {}, useCallback() {}, useRef() {} }
  }
  throw new Error(`unexpected require("${spec}") — not in official baseline`)
}

function makeFakeCtx() {
  const injected = {}
  const registrations = []
  const ctx = {
    slots: {
      inject(slot, cb) { injected[slot] = cb },
      register(options, component) { registrations.push({ options, component }); return () => {} },
    },
    layout: { selectPanel() {} },
  }
  return { ctx, injected, registrations }
}

test('bundle: registration id + exports + baseline externals only', () => {
  const reg = loadRegistration(bundlePath)
  assert.equal(reg.id, '@dsh-platform/cmcc-platform-ui')
  const exportsObj = reg.factory(mockRequire) // 非 baseline 会 throw
  assert.equal(typeof exportsObj.apply, 'function')
  assert.deepEqual(exportsObj.inject, ['slots', 'layout'])
})

test('apply: registers public entries and admin usage entry in order', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ role: 'tenant_admin' }), { headers: { 'content-type': 'application/json' } })
  try {
  const reg = loadRegistration(bundlePath)
  const exportsObj = reg.factory(mockRequire)
  const { ctx, injected, registrations } = makeFakeCtx()
  exportsObj.apply(ctx)
  assert.ok(injected['sidebar.panellist'], 'sidebar.panellist not injected')
  injected['sidebar.panellist']()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const sidebar = registrations.filter((r) => r.options.name === 'sidebar.panellist')
  assert.equal(sidebar.length, 5)
  for (const exp of EXPECTED) {
    const entry = sidebar.find((r) => r.options.id === exp.id)
    assert.ok(entry, `missing sidebar entry ${exp.id}`)
    assert.deepEqual(entry.options, { name: 'sidebar.panellist', id: exp.id, order: exp.order, label: exp.label })
    assert.equal(typeof entry.component, 'function')
  }
  } finally { globalThis.fetch = originalFetch }
})

test('apply: registers 5 main keyed panels; admin sidebar id == main key', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ role: 'tenant_admin' }), { headers: { 'content-type': 'application/json' } })
  try {
  const reg = loadRegistration(bundlePath)
  const exportsObj = reg.factory(mockRequire)
  const { ctx, injected, registrations } = makeFakeCtx()
  exportsObj.apply(ctx)
  assert.ok(injected['main'], 'main not injected')
  injected['sidebar.panellist']()
  await new Promise((resolve) => setTimeout(resolve, 0))
  injected['main']()
  const main = registrations.filter((r) => r.options.name === 'main')
  assert.equal(main.length, 5)
  for (const exp of EXPECTED) {
    const entry = main.find((r) => r.options.key === exp.id)
    assert.ok(entry, `missing main key ${exp.id}`)
    assert.equal(typeof entry.component, 'function')
  }
  const sidebarIds = registrations.filter((r) => r.options.name === 'sidebar.panellist').map((r) => r.options.id).sort()
  const mainKeys = main.map((r) => r.options.key).sort()
  assert.deepEqual(sidebarIds, mainKeys, 'sidebar id set must equal main key set')
  } finally { globalThis.fetch = originalFetch }
})

test('apply: non-admin never sees usage entry', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ role: 'member' }), { headers: { 'content-type': 'application/json' } })
  try {
    const reg = loadRegistration(bundlePath)
    const { ctx, injected, registrations } = makeFakeCtx()
    reg.factory(mockRequire).apply(ctx)
    injected['sidebar.panellist']()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const ids = registrations.filter((entry) => entry.options.name === 'sidebar.panellist').map((entry) => entry.options.id)
    assert.equal(ids.length, 4)
    assert.ok(!ids.includes('cmcc.usage'))
  } finally { globalThis.fetch = originalFetch }
})

test('apply: cmcc.smoke is NOT registered', () => {
  const reg = loadRegistration(bundlePath)
  const exportsObj = reg.factory(mockRequire)
  const { ctx, injected, registrations } = makeFakeCtx()
  exportsObj.apply(ctx)
  injected['sidebar.panellist']()
  injected['main']()
  const ids = registrations.map((r) => r.options.id).concat(registrations.map((r) => r.options.key))
  assert.ok(!ids.includes('cmcc.smoke'), 'cmcc.smoke must not be a production entry')
})

test('apply: minimal CMCC brand registered into sidebar.brand slots', () => {
  const reg = loadRegistration(bundlePath)
  const exportsObj = reg.factory(mockRequire)
  const { ctx, injected, registrations } = makeFakeCtx()
  exportsObj.apply(ctx)
  assert.ok(injected['sidebar.brand.mark'], 'brand mark not injected')
  assert.ok(injected['sidebar.brand.name'], 'brand name not injected')
  injected['sidebar.brand.mark']()
  injected['sidebar.brand.name']()
  assert.ok(registrations.some((r) => r.options.name === 'sidebar.brand.mark'))
  assert.ok(registrations.some((r) => r.options.name === 'sidebar.brand.name'))
})
