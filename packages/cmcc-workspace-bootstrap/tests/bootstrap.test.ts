/**
 * cmcc-workspace-bootstrap 测试:幂等注册 / 缺失目录可观测失败 / 空路径 no-op。
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { bootstrapDefaultWorkspace } from '../src/index.js'

interface Workspace { id: string; path: string; title: string }

function fakeRegistry(opts: { fail?: boolean } = {}): { registry: { create: (p: string, t?: string) => Promise<Workspace> }; calls: Array<{ path: string; title?: string }> } {
  const calls: Array<{ path: string; title?: string }> = []
  return {
    calls,
    registry: {
      create: async (p: string, t?: string) => {
        calls.push({ path: p, title: t })
        if (opts.fail === true) throw new Error('registry-error')
        return { id: 'ws-1', path: p, title: t ?? 'x' }
      },
    },
  }
}

test('bootstrap: existing dir → create called, returns true', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cmcc-ws-'))
  const { registry, calls } = fakeRegistry()
  const ok = await bootstrapDefaultWorkspace(registry, dir, '我的工作区')
  assert.equal(ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.path, dir)
  assert.equal(calls[0]?.title, '我的工作区')
})

test('bootstrap: empty path → no-op false', async () => {
  const { registry, calls } = fakeRegistry()
  assert.equal(await bootstrapDefaultWorkspace(registry, '', 't'), false)
  assert.equal(calls.length, 0)
})

test('bootstrap: missing dir → observable failure, no create call', async () => {
  const { registry, calls } = fakeRegistry()
  const warnings: string[] = []
  const ok = await bootstrapDefaultWorkspace(registry, path.join(tmpdir(), 'cmcc-missing-' + Date.now()), 't', { warn: (m) => warnings.push(m) })
  assert.equal(ok, false)
  assert.equal(calls.length, 0)
  assert.ok(warnings.some((w) => w.includes('missing')))
})

test('bootstrap: registry create failure → false + warning (no throw)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cmcc-ws-'))
  const { registry } = fakeRegistry({ fail: true })
  const warnings: string[] = []
  const ok = await bootstrapDefaultWorkspace(registry, dir, 't', { warn: (m) => warnings.push(m) })
  assert.equal(ok, false)
  assert.ok(warnings.some((w) => w.includes('create-failed')))
})

test('bootstrap: idempotent — repeated calls both invoke create (registry dedupes)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cmcc-ws-'))
  const { registry, calls } = fakeRegistry()
  await bootstrapDefaultWorkspace(registry, dir, 't')
  await bootstrapDefaultWorkspace(registry, dir, 't')
  assert.equal(calls.length, 2)
})