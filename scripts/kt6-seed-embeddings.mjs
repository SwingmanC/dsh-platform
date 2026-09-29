/**
 * K-T6-lite §17:测试/开发专用 seed 脚本(不接入产品路径)。
 * 用法:cd apps/gateway && node --import tsx ..\..\scripts\kt6-seed-embeddings.mjs --kb <kbId> --provider <mockUrl>
 * 行为:读取该 KB 全部 ready chunks → mock embedding → MySQLBlobVectorStore.upsert。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require2 = createRequire(new URL('../apps/gateway/package.json', import.meta.url))

// 1) 读取 .env 的 MYSQL_*(先于 gateway 模块导入,池在 import 时建立)
const env = readFileSync(path.join(repoRoot, '.env'), 'utf8')
for (const m of env.matchAll(/^(MYSQL_[A-Z_]+)=(.*)$/gm)) process.env[m[1]] = m[2]

const args = process.argv.slice(2)
const kbId = args[args.indexOf('--kb') + 1]
const providerUrl = args[args.indexOf('--provider') + 1] ?? 'http://127.0.0.1:9098/v1'
if (!kbId) { console.error('--kb required'); process.exit(1) }

// 2) 导入(在 env 就绪后)
const { queryMany } = await import('../apps/gateway/src/db.js')
const { mysqlBlobVectorStore } = await import('../apps/gateway/src/rag/mysql-blob-vector-store.js')
const { embedTexts } = await import('../apps/gateway/src/rag/embedding-client.js')

const chunks = await queryMany(
  `SELECT c.id, c.doc_id AS docId, c.kb_id AS kbId, c.content
     FROM t_dsh_knowledge_chunks c
     JOIN t_dsh_knowledge_documents d ON d.id = c.doc_id AND d.status = 'ready'
    WHERE c.kb_id = ? AND c.embedding IS NULL`, [kbId])
console.log(`chunks to embed: ${chunks.length}`)

// 3) mock embedding(确定性、无真实外部服务)
const vectors = await embedTexts(
  { baseUrl: providerUrl, model: 'mock', dims: 16, apiKey: null },
  chunks.map((c) => c.content),
  { egressPolicy: { allowedOrigins: [], allowLoopback: true } },
)

// 4) VectorStore.upsert(生产写入路径;tenant 取自 KB 归属)
const rows = await queryMany(`SELECT c.id, c.doc_id AS docId, c.kb_id AS kbId, kb.tenant_id AS tenantId
                                FROM t_dsh_knowledge_chunks c JOIN t_dsh_knowledge_bases kb ON kb.id = c.kb_id
                               WHERE c.kb_id = ?`, [kbId])
const tenantByChunk = new Map(rows.map((r) => [r.id, r]))
await mysqlBlobVectorStore.upsert(chunks.map((c, i) => ({
  chunkId: c.id, docId: c.docId, kbId: c.kbId,
  tenantId: tenantByChunk.get(c.id)?.tenantId,
  embedding: vectors[i] ?? [],
})))
console.log(`seeded: ${chunks.length} embeddings via VectorStore.upsert`)
process.exit(0)
