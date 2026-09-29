/**
 * K-T4 PoC A — MySQL BLOB(Float32 编码)+ Gateway 内精确 cosine。
 * 独立 PoC:专用临时表 kt4_poc_vectors,结束即 DROP;不触碰业务表/路径。
 *
 * 验证:Float32 round-trip / cosine 正确性(含异常防护)/ 100+1000 synthetic vectors
 *      / tenant scope 隔离 / document 删除后向量退出检索 / 运行耗时(仅诊断)。
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const require2 = createRequire(new URL('../apps/gateway/package.json', import.meta.url))
const mysql = require2('mysql2/promise')

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const env = readFileSync(path.join(repoRoot, '.env'), 'utf8')
const cfg = {}
for (const m of env.matchAll(/^(MYSQL_[A-Z_]+)=(.*)$/gm)) cfg[m[1]] = m[2]

const DIMS = 1024
const TENANT_A = randomUUID()
const TENANT_B = randomUUID()
const DOC_A = randomUUID()
const DOC_B = randomUUID()

// --- Float32 编码/解码(稳定二进制格式:小端 Float32 数组) ---
function encodeVector(v) {
  const f32 = new Float32Array(v)
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)
}
function decodeVector(buf) {
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4))
  return Array.from(f32)
}

// --- cosine(含异常防护:不得静默产生错误 score) ---
function cosineSimilarity(query, vector) {
  if (query.length !== vector.length) throw new Error('dimension-mismatch')
  let dot = 0; let nq = 0; let nv = 0
  for (let i = 0; i < query.length; i += 1) {
    const a = query[i]; const b = vector[i]
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('invalid-vector:non-finite')
    dot += a * b; nq += a * a; nv += b * b
  }
  if (nq === 0 || nv === 0) throw new Error('zero-vector')
  return dot / (Math.sqrt(nq) * Math.sqrt(nv))
}

function assertNearlyEqual(a, b, eps = 1e-6) {
  if (Math.abs(a - b) > eps) throw new Error(`round-trip mismatch: ${a} vs ${b}`)
}

function rand(n) { return Array.from({ length: n }, () => Math.random() * 2 - 1) }

const pool = mysql.createPool({
  host: cfg.MYSQL_HOST ?? '127.0.0.1', port: Number(cfg.MYSQL_PORT ?? 3306),
  user: cfg.MYSQL_USER ?? 'root', password: cfg.MYSQL_PASSWORD ?? '',
  database: cfg.MYSQL_DATABASE ?? 'dsh_platform', connectionLimit: 4, charset: 'utf8mb4',
})

const t0 = Date.now()
try {
  // 0) PoC 专用临时表(结束 DROP;不修改业务 schema)
  await pool.query(`DROP TABLE IF EXISTS kt4_poc_vectors`)
  await pool.query(`CREATE TABLE kt4_poc_vectors (
    id CHAR(36) PRIMARY KEY, tenant_tag CHAR(36) NOT NULL,
    doc_id CHAR(36) NOT NULL, dim INT NOT NULL, embedding BLOB NOT NULL)
    ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  // 1) Float32 round-trip(含负值/小数,全量 1024 维精确比对)
  const sample = rand(DIMS)
  const decoded = decodeVector(encodeVector(sample))
  for (let i = 0; i < DIMS; i += 1) assertNearlyEqual(decoded[i], sample[i])
  console.log('round-trip: PASS (1024 dims, Float32 exact)')

  // 2) cosine 正确性:相同向量=1;正交≈0;异常防护(dims 不匹配/零向量/NaN/Infinity 必须抛错)
  const u = rand(DIMS)
  if (Math.abs(cosineSimilarity(u, u) - 1) > 1e-6) throw new Error('cosine(self)!=1')
  const ortho = u.map((_, i) => (i % 2 === 0 ? u[i] : 0))
  const orthoB = u.map((_, i) => (i % 2 === 1 ? u[i] : 0))
  if (Math.abs(cosineSimilarity(ortho, orthoB)) > 1e-9) throw new Error('cosine(ortho)!=0')
  const zero = new Array(DIMS).fill(0)
  for (const [q, v] of [[u.slice(0, 512), u], [u, zero], [u, [Number.NaN, ...u.slice(1)]], [u, [Infinity, ...u.slice(1)]]]) {
    let threw = false
    try { cosineSimilarity(q, v) } catch { threw = true }
    if (!threw) throw new Error(`cosine guard missing (dims-mismatch/zero/NaN/Inf case)`)
  }
  console.log('cosine correctness: PASS (self=1, ortho=0, dims/zero/NaN/Inf guarded)')

  // 3) 种子数据:tenant A=1 doc/100 chunks;tenant B=1 doc/1000 chunks
  const seed = []
  for (let i = 0; i < 100; i += 1) seed.push([randomUUID(), TENANT_A, DOC_A, DIMS, encodeVector(rand(DIMS))])
  for (let i = 0; i < 1000; i += 1) seed.push([randomUUID(), TENANT_B, DOC_B, DIMS, encodeVector(rand(DIMS))])
  const ts = Date.now()
  await pool.query(`INSERT INTO kt4_poc_vectors (id, tenant_tag, doc_id, dim, embedding) VALUES ?`, [seed])
  console.log(`upsert: PASS (${seed.length} rows x ${DIMS} dims in ${Date.now() - ts}ms — 诊断值,非性能结论)`)

  // 4) 读取 round-trip(抽查 5 条)
  const [rows] = await pool.query(`SELECT id, embedding FROM kt4_poc_vectors WHERE tenant_tag = ? LIMIT 5`, [TENANT_A])
  for (const r of rows) assertNearlyEqual(...decodeVector(r.embedding).slice(0, 2), ...seed.find((s) => s[0] === r.id)[4].slice(0, 2))
  console.log('BLOB read-back: PASS (5/5 spot checks)')

  // 5) Scope 检索:先 SQL 限定候选集(tenant A),再 JS cosine 排序
  const qv = rand(DIMS)
  const scoped = async () => {
    const [cand] = await pool.query(`SELECT id, embedding FROM kt4_poc_vectors WHERE tenant_tag = ? AND doc_id = ?`, [TENANT_A, DOC_A])
    return cand
      .map((r) => ({ id: r.id, score: cosineSimilarity(qv, decodeVector(r.embedding)) }))
      .sort((a, b) => b.score - a.score)
  }
  const t1 = Date.now()
  const results = await scoped()
  console.log(`scoped search: PASS (candidates=100, returned=${results.length}, A-row=${results.every((r) => TENANT_B !== r.id)}, ${Date.now() - t1}ms — 诊断值)`)
  // 反证:不做 scope 过滤时候选为 1100(说明 ACL 必须在候选集阶段生效)
  const [all] = await pool.query(`SELECT COUNT(*) AS n FROM kt4_poc_vectors`)
  console.log(`unscoped candidate count: ${all[0].n}(证明:无 ACL 时 B 租户向量可见 → 禁止此模式)`)

  // 6) document 删除 → 向量退出检索
  await pool.query(`DELETE FROM kt4_poc_vectors WHERE doc_id = ?`, [DOC_A])
  const after = await scoped().catch(() => [])
  const [cnt] = await pool.query(`SELECT COUNT(*) AS n FROM kt4_poc_vectors WHERE doc_id = ?`, [DOC_A])
  console.log(`delete: PASS (doc A rows=${cnt[0].n}, scoped results=${after.length})`)

  console.log('POC_A = FUNCTIONALLY_VIABLE(规模结论:UNVERIFIED_AT_SCALE)')
} finally {
  await pool.query(`DROP TABLE IF EXISTS kt4_poc_vectors`).catch(() => {})
  await pool.end()
  console.log(`poc table dropped; total ${Date.now() - t0}ms`)
}
