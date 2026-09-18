/**
 * cmcc-knowledge-runtime 测试:投影读取 / tool search/read 验证。
 * 无 DSH Runtime、无网络、无 DB。
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readProjection } from '../src/projection-reader.js'

const PROJ_REVISION = 'test-rev-1'

async function makeProjection(chunks: Array<{ chunkId: string; snippet: string; kbName?: string; documentTitle?: string }>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cmcc-know-'))
  await mkdir(dir, { recursive: true })
  const data = {
    schemaVersion: 1, revision: PROJ_REVISION, generatedAt: new Date().toISOString(),
    tenantId: 't1', userId: 'u1',
    chunks: chunks.map((c) => ({
      chunkId: c.chunkId, docId: 'doc-1', kbId: 'kb-1',
      kbName: c.kbName ?? 'TestKB', documentTitle: c.documentTitle ?? 'test.md',
      ordinal: 0, snippet: c.snippet, score: 0,
    })),
    mountedKbIds: ['kb-1'],
  }
  await writeFile(path.join(dir, 'projection.json'), JSON.stringify(data), 'utf8')
  return dir
}

test('readProjection: returns null for missing dir', async () => {
  const result = await readProjection('/nonexistent/path')
  assert.equal(result, null)
})

test('readProjection: returns parsed data for valid projection', async () => {
  const dir = await makeProjection([
    { chunkId: 'c1', snippet: '上海是中国的一座大城市' },
    { chunkId: 'c2', snippet: '北京是中国的首都' },
  ])
  const result = await readProjection(dir)
  assert.ok(result !== null)
  assert.equal(result.revision, PROJ_REVISION)
  assert.equal(result.chunks.length, 2)
  assert.equal(result.chunks[0].chunkId, 'c1')
  assert.equal(result.chunks[1].chunkId, 'c2')
})

test('readProjection: invalid JSON returns null', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cmcc-know-'))
  await writeFile(path.join(dir, 'projection.json'), 'not json', 'utf8')
  const result = await readProjection(dir)
  assert.equal(result, null)
})

test('readProjection: null for missing revision field', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cmcc-know-'))
  await writeFile(path.join(dir, 'projection.json'), JSON.stringify({ chunks: [] }), 'utf8')
  const result = await readProjection(dir)
  assert.equal(result, null)
})