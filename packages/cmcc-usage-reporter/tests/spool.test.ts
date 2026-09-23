import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { UsageSpool } from '../src/spool.js'
import type { UsagePayload } from '../src/spool.js'

const payload: UsagePayload = {
  sessionId: 'session-1', eventSeq: 7, occurredAt: '2026-09-23T08:00:00.000Z',
  provider: 'deepseek-official', model: 'deepseek-flash', inputTokens: 100, outputTokens: 20,
  cacheReadTokens: 10, cacheWriteTokens: 0, reasoningTokens: 5,
}

async function withSpoolDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cmcc-usage-spool-'))
  try { await run(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

test('non-2xx response keeps event on disk and a new runtime can replay it', async () => {
  await withSpoolDir(async (dir) => {
    const logs: string[] = []
    const failed = new UsageSpool(dir, 'http://127.0.0.1:8080', 'old-token',
      (async () => new Response('', { status: 401 })) as typeof fetch, (message) => logs.push(message))
    await failed.enqueue(payload)
    assert.equal((await readdir(dir)).filter((name) => name.endsWith('.json')).length, 1)
    assert.ok(logs.some((message) => message.includes('HTTP 401')))
    assert.ok(logs.every((message) => !message.includes('old-token')))

    const replayed: UsagePayload[] = []
    const recovered = new UsageSpool(dir, 'http://127.0.0.1:8080', 'new-token',
      (async (_url, init) => { replayed.push(JSON.parse(String(init?.body)) as UsagePayload); return new Response('', { status: 201 }) }) as typeof fetch)
    await recovered.flush()
    assert.equal(replayed.length, 1)
    assert.deepEqual(replayed[0], payload)
    assert.deepEqual(await readdir(dir), [])
  })
})

test('network error leaves event queued for retry', async () => {
  await withSpoolDir(async (dir) => {
    const failed = new UsageSpool(dir, 'http://127.0.0.1:8080', 'token',
      (async () => { throw new Error('offline') }) as typeof fetch, () => {})
    await failed.enqueue(payload)
    assert.equal((await readdir(dir)).filter((name) => name.endsWith('.json')).length, 1)
  })
})

test('missing channel configuration still persists events for a later runtime', async () => {
  await withSpoolDir(async (dir) => {
    const logs: string[] = []
    const unconfigured = new UsageSpool(dir, '', '',
      (async () => { throw new Error('must not send') }) as typeof fetch, (message) => logs.push(message))
    await unconfigured.enqueue(payload)
    assert.equal((await readdir(dir)).filter((name) => name.endsWith('.json')).length, 1)
    assert.ok(logs.some((message) => message.includes('未配置')))
    const configured = new UsageSpool(dir, 'http://127.0.0.1:8080', 'token',
      (async () => new Response('', { status: 201 })) as typeof fetch)
    await configured.flush()
    assert.deepEqual(await readdir(dir), [])
  })
})

test('invalid event is quarantined, not silently deleted', async () => {
  await withSpoolDir(async (dir) => {
    const failed = new UsageSpool(dir, 'http://127.0.0.1:8080', 'token',
      (async () => new Response('', { status: 400 })) as typeof fetch, () => {})
    await failed.enqueue(payload)
    assert.equal((await readdir(dir)).filter((name) => name.endsWith('.rejected')).length, 1)
  })
})

test('corrupt file is quarantined without blocking valid events', async () => {
  await withSpoolDir(async (dir) => {
    await writeFile(path.join(dir, `${'0'.repeat(64)}.json`), '{not-json', { mode: 0o600 })
    const sent: UsagePayload[] = []
    const spool = new UsageSpool(dir, 'http://127.0.0.1:8080', 'token',
      (async (_url, init) => { sent.push(JSON.parse(String(init?.body)) as UsagePayload); return new Response('', { status: 201 }) }) as typeof fetch,
      () => {})
    await spool.enqueue(payload)
    assert.equal(sent.length, 1)
    assert.equal((await readdir(dir)).filter((name) => name.endsWith('.corrupt')).length, 1)
  })
})
