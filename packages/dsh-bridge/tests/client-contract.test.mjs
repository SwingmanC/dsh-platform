/**
 * dsh-bridge client bundle 契约测试(无浏览器)。
 * 验证单一真源产物 `lib/client.js`:id / apply / sidebar.footer.action 注册。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = resolve(here, '../lib/client.js')

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
    return { jsx() {}, jsxs() {}, Fragment: {}, createElement() {}, useState() {}, useEffect() {}, useCallback() {} }
  }
  throw new Error(`unexpected require("${spec}") — not in official baseline`)
}

test('dsh-bridge bundle: registration id + apply + footer action', () => {
  const reg = loadRegistration(bundlePath)
  assert.equal(reg.id, '@dsh-platform/dsh-bridge')
  const exportsObj = reg.factory(mockRequire)
  assert.equal(typeof exportsObj.apply, 'function')
  assert.deepEqual(exportsObj.inject, ['slots'])

  const injected = {}
  const registrations = []
  const ctx = {
    slots: {
      inject(slot, cb) { injected[slot] = cb },
      register(options, component) { registrations.push({ options, component }); return () => {} },
    },
  }
  exportsObj.apply(ctx)
  assert.ok(injected['sidebar.footer.action'], 'sidebar.footer.action not injected')
  injected['sidebar.footer.action']()
  const entry = registrations.find((r) => r.options.name === 'sidebar.footer.action')
  assert.ok(entry, 'sidebar.footer.action not registered')
  assert.equal(entry.options.id, 'platform-account')
  assert.equal(entry.options.order, 100)
  assert.equal(typeof entry.component, 'function')
})
