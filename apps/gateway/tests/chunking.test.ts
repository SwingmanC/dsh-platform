/**
 * K-T2-lite 分块算法单测:段落优先 + 标题感知 + 超长段落切分 + overlap + 非法参数守卫。
 * 纯函数测试,无 DB/网络/服务依赖。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chunkDocument, resolveChunkParams, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP } from '../src/ingestion.js'

test('Case 1: 普通短段落不产生不必要切分', () => {
  const text = '第一段内容。\n\n第二段内容。'
  const chunks = chunkDocument(text, 800, 120)
  assert.equal(chunks.length, 1)
  assert.ok(chunks[0]!.content.includes('第一段内容'))
  assert.ok(chunks[0]!.content.includes('第二段内容'))
  assert.ok(chunks[0]!.content.length <= 800)
})

test('Case 2: 多段落优先按段落边界组合,不截断段落', () => {
  const p1 = 'a'.repeat(59) + '1'
  const p2 = 'b'.repeat(59) + '2'
  const p3 = 'c'.repeat(59) + '3'
  const text = [p1, p2, p3].join('\n\n')
  const chunks = chunkDocument(text, 130, 0)
  assert.equal(chunks.length, 2)
  // chunk1 = p1+p2(整段组合,60+2+60=122 ≤ 130);chunk2 = p3
  assert.equal(chunks[0]!.content.length, 122)
  assert.ok(chunks[0]!.content.includes(p1) && chunks[0]!.content.includes(p2))
  assert.equal(chunks[1]!.content, p3)
  // 每个段落完整地出现在且仅出现在一个 chunk 中
  for (const p of [p1, p2, p3]) {
    assert.equal(chunks.filter((c) => c.content.includes(p)).length, 1)
  }
})

test('Case 3: Markdown 标题边界行为不回归', () => {
  const text = 'body-line-1\n# Heading\ntail after heading'
  const chunks = chunkDocument(text, 30, 0)
  assert.equal(chunks.length, 2)
  // 标题前内容独立成块;标题开启新块且正文跟随其后
  assert.equal(chunks[0]!.content, 'body-line-1')
  assert.ok(chunks[1]!.content.startsWith('# Heading'))
  assert.ok(chunks[1]!.content.includes('tail after heading'))
})

test('Case 4: 超长单段落被切分为多个 chunk,且均不超过上限', () => {
  const para = 'x'.repeat(1200)
  const chunks = chunkDocument(para, 800, 120)
  assert.ok(chunks.length >= 2)
  for (const c of chunks) {
    assert.ok(c.content.length > 0)
    assert.ok(c.content.length <= 800, `chunk length ${c.content.length} exceeds 800`)
  }
  // 覆盖完整性:相邻 chunk 首尾相接(重叠区一致),拼接可还原原文
  assert.equal(chunks[0]!.content + chunks[1]!.content.slice(120), para)
})

test('Case 5: 连续 chunk 存在预期 overlap(滑动窗)', () => {
  const para = 'y'.repeat(250)
  const chunks = chunkDocument(para, 100, 20)
  assert.ok(chunks.length >= 3)
  for (const c of chunks) assert.ok(c.content.length <= 100)
  for (let i = 0; i + 1 < chunks.length; i += 1) {
    const tail = chunks[i]!.content.slice(-20)
    const head = chunks[i + 1]!.content.slice(0, 20)
    assert.equal(tail, head, `chunk ${i} 与 ${i + 1} 缺少 20 字符 overlap`)
  }
})

test('Case 6: 非法配置不崩溃、不死循环、不产生空 chunk', () => {
  const text = 'z'.repeat(1000)
  const cases: Array<[number, number]> = [
    [0, 0], [-5, -3], [100, 100], [100, 200], [100, -1], [Number.NaN, Number.NaN],
  ]
  for (const [size, ov] of cases) {
    const chunks = chunkDocument(text, size, ov)
    assert.ok(chunks.length >= 1, `size=${size} overlap=${ov} produced no chunks`)
    for (const c of chunks) {
      assert.ok(c.content.trim().length > 0, `size=${size} overlap=${ov} produced empty chunk`)
    }
  }
  // 参数解析守卫的直接断言(overlap=0 是合法配置;仅 maxSize 非法或 overlap≥size 时整体回退)
  assert.deepEqual(resolveChunkParams(0, 0), { size: DEFAULT_CHUNK_SIZE, overlap: 0 })
  assert.deepEqual(resolveChunkParams(-5, -3), { size: DEFAULT_CHUNK_SIZE, overlap: 0 })
  assert.deepEqual(resolveChunkParams(100, 100), { size: DEFAULT_CHUNK_SIZE, overlap: DEFAULT_CHUNK_OVERLAP })
  assert.deepEqual(resolveChunkParams(100, -1), { size: 100, overlap: 0 })
  assert.deepEqual(resolveChunkParams(undefined, undefined), { size: DEFAULT_CHUNK_SIZE, overlap: DEFAULT_CHUNK_OVERLAP })
})

test('向后兼容:默认参数来自 config(800/120),txt/md extractText 行为不变', () => {
  const chunks = chunkDocument('hello')
  assert.ok(chunks.length >= 1)
  assert.deepEqual(resolveChunkParams(undefined, undefined), { size: 800, overlap: 120 })
})
