/**
 * K-T7 单测:Citation 稳定 ID(纯函数)。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildCitationId, parseCitationId } from '../src/rag/citation.js'

const PARTS = { kbId: 'kb-111', docId: 'doc-222', versionId: 'ver-333', chunkId: 'chunk-444' }

test('§18 稳定生成:连续两次一致', () => {
  const a = buildCitationId(PARTS)
  const b = buildCitationId(PARTS)
  assert.equal(a, b)
  assert.equal(a, 'kb:kb-111:doc:doc-222:ver:ver-333:chunk:chunk-444')
})

test('parse round-trip', () => {
  const id = buildCitationId(PARTS)
  assert.deepEqual(parseCitationId(id), PARTS)
})

test('§17 malformed citationId → null', () => {
  for (const bad of ['', 'random-uuid', 'kb:doc:chunk', 'kb::doc:x:ver:y:chunk:z', 'x:kb-1:doc:d:ver:v:chunk:c:extra']) {
    assert.equal(parseCitationId(bad), null, `expected null for ${JSON.stringify(bad)}`)
  }
})
