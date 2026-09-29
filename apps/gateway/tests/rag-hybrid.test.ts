/**
 * K-T6-lite 单测:RRF 融合(§21 确定/稳定)+ 语义命中场景(§19,纯函数级,mock 排序)。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rrfFuse } from '../src/rag/hybrid.js'
import { encodeFloat32Vector, decodeFloat32Vector, cosineSimilarity } from '../src/rag/vector-store.js'

function chunk(id: string, content: string) {
  return { chunkId: id, content }
}

test('§21 Hybrid Test: keyword A,B,C × vector B,D,A → RRF 确定性融合', () => {
  const k = [chunk('A', 'a'), chunk('B', 'b'), chunk('C', 'c')]
  const v = [chunk('B', 'b'), chunk('D', 'd'), chunk('A', 'a')]
  const fused = rrfFuse(k, v, { k: 60, topK: 10 })
  // 得分:A = 1/61 + 1/63;B = 1/62 + 1/61;C = 1/63;D = 1/62
  const scoreOf = (id: string): number => fused.find((f) => f.chunk.chunkId === id)!.score
  assert.ok(Math.abs(scoreOf('A') - (1 / 61 + 1 / 63)) < 1e-12)
  assert.ok(Math.abs(scoreOf('B') - (1 / 62 + 1 / 61)) < 1e-12)
  assert.ok(Math.abs(scoreOf('C') - 1 / 63) < 1e-12)
  assert.ok(Math.abs(scoreOf('D') - 1 / 62) < 1e-12)
  // 排序:B(0.03279) > A(0.03226) > D(0.01639) > C(0.01587)
  assert.deepEqual(fused.map((f) => f.chunk.chunkId), ['B', 'A', 'D', 'C'])
  assert.equal(fused[0]!.sources, 'kv')
  assert.equal(fused[2]!.sources, 'v')
})

test('§21 topK 截断:默认 6 / 自定义', () => {
  const ids = Array.from({ length: 10 }, (_, i) => `c${i}`)
  const fusedAll = rrfFuse(ids.map((i) => chunk(i, i)), [], { topK: 10 })
  assert.equal(fusedAll.length, 10)
  assert.ok(rrfFuse(ids.map((i) => chunk(i, i)), [], { topK: 3 }).length === 3)
})

test('Float32 编解码 round-trip(使用 Float32 精确可表示的值)', () => {
  const v = Array.from({ length: 16 }, (_, i) => (i - 8) / 4)
  const decoded = decodeFloat32Vector(encodeFloat32Vector(v))
  assert.deepEqual(decoded, v)
})

test('Float32 编码守卫:空向量/NaN/维度不匹配', () => {
  assert.throws(() => encodeFloat32Vector([], 4), /invalid-vector:empty/)
  assert.throws(() => encodeFloat32Vector([1, Number.NaN, 3], 3), /invalid-vector:non-finite/)
  assert.throws(() => encodeFloat32Vector([1, 2], 3), /dimension-mismatch/)
})

test('cosine 守卫:零向量/维度不匹配/非有限值', () => {
  const v4 = [1, 2, 3, 4]
  assert.throws(() => cosineSimilarity(v4.slice(0, 3), v4), /dimension-mismatch/)
  assert.throws(() => cosineSimilarity(v4, [0, 0, 0, 0]), /zero-vector/)
  assert.throws(() => cosineSimilarity(v4, [Number.NaN, 2, 3, 4]), /invalid-vector:non-finite/)
})

test('§19 语义命中(mock embedding 排序,纯函数级):keyword 无命中时 vector 单独给出结果', () => {
  // keyword LIKE 对「出差坐高铁的钱能报吗」无直接命中 → keyword 列表为空
  // mock vector:差旅文档 chunk 语义相近,排第一
  const travel = chunk('doc-travel-1', '员工差旅可以报销城际交通费用')
  const fused = rrfFuse([], [travel], { topK: 6 })
  assert.equal(fused.length, 1)
  assert.equal(fused[0]!.chunk.chunkId, 'doc-travel-1')
  assert.ok(fused[0]!.score > 0)
})
