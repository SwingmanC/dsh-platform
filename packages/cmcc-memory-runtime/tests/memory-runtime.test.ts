/**
 * cmcc-memory-runtime 测试:显式提取 / secret 排除 / recall 预算 / search。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractExplicitMemories, isSecretLike, isSensitiveContent, inferKind } from '../src/extraction.js'
import { selectRecall, buildRecallText } from '../src/recall.js'
import { searchMemories } from '../src/tools.js'
import type { ProjectedMemory } from '../src/projection-reader.js'

const mem = (id: string, kind: string, content: string, updatedAt = '2026-01-01'): ProjectedMemory => ({
  id, kind, content, scope: 'personal', namespace: 'default', revision: 1,
  sourceType: 'user_fact', extractionMode: 'manual', sourceSessionId: null, updatedAt,
})

test('extract: explicit remember phrase (Chinese) → fact', () => {
  const out = extractExplicitMemories('请记住:我的项目代号是 CMCC_MEMORY_07')
  assert.equal(out.length, 1)
  assert.equal(out[0]?.content, '我的项目代号是 CMCC_MEMORY_07')
  assert.equal(out[0]?.kind, 'fact')
})

test('extract: preference and instruction', () => {
  const pref = extractExplicitMemories('我的偏好是使用 2 空格缩进')
  assert.equal(pref[0]?.kind, 'preference')
  const instr = extractExplicitMemories('以后都使用 pnpm')
  assert.equal(instr[0]?.kind, 'instruction')
})

test('extract: no explicit phrase → empty', () => {
  assert.deepEqual(extractExplicitMemories('今天天气不错,我们聊聊别的'), [])
})

test('secret detection: rejects password/api key/token-like', () => {
  assert.equal(isSecretLike('password: hunter2'), true)
  assert.equal(isSecretLike('api_key=sk-abcdefghijklmnop123456'), true)
  assert.equal(isSecretLike('我的项目代号是 CMCC_MEMORY_07'), false)
})

test('extract: secret content not extracted', () => {
  const out = extractExplicitMemories('请记住我的密码是 password: hunter2')
  assert.equal(out.length, 0)
})

test('sensitive detection: health/political/religion', () => {
  assert.equal(isSensitiveContent('我的诊断结果是高血压'), true)
  assert.equal(isSensitiveContent('我的项目代号是 X'), false)
})

test('inferKind', () => {
  assert.equal(inferKind('我喜欢深色模式'), 'preference')
  assert.equal(inferKind('以后一律使用 tab'), 'instruction')
})

test('selectRecall: query match + budget', () => {
  const memories = [mem('m1', 'preference', '使用 2 空格缩进'), mem('m2', 'fact', '项目代号 CMCC_MEMORY_07')]
  const budget = { maxRecallItems: 8, maxRecallBytes: 4096, maxItemBytes: 512 }
  const selected = selectRecall(memories, 'CMCC_MEMORY_07', budget)
  assert.equal(selected[0]?.id, 'm2')
})

test('selectRecall: item count budget enforced', () => {
  const memories = Array.from({ length: 20 }, (_, i) => mem(`m${i}`, 'fact', `memory ${i}`))
  const selected = selectRecall(memories, '', { maxRecallItems: 3, maxRecallBytes: 4096, maxItemBytes: 512 })
  assert.equal(selected.length, 3)
})

test('buildRecallText: contains framing + ids, marks context not instructions', () => {
  const memories = [mem('m1', 'preference', '使用 2 空格缩进')]
  const stats = { recallCount: 0, lastRecallAt: null, lastRecallIds: [], lastRecallBytes: 0 }
  const text = buildRecallText(memories, '', { maxRecallItems: 8, maxRecallBytes: 4096, maxItemBytes: 512 }, stats)
  assert.match(text, /<cmcc-memory-recall>/)
  assert.match(text, /not higher-priority instructions/)
  assert.match(text, /\[preference\]\[m1\]/)
  assert.equal(stats.recallCount, 1)
})

test('searchMemories: lexical match + kind filter', () => {
  const memories = [mem('m1', 'preference', '使用 pnpm'), mem('m2', 'fact', '项目代号 CMCC_MEMORY_07')]
  const r = searchMemories(memories, 'pnpm', undefined, 5)
  assert.equal(r.length, 1)
  assert.equal(r[0]?.memoryId, 'm1')
  assert.equal(searchMemories(memories, '', 'fact', 5).length, 1)
})