/**
 * K-T5-lite §14:开发/测试工具 — 为指定 tenant + document 补生成 embedding。
 * 用法:cd apps/gateway && node --import tsx ..\..\scripts\kt5-backfill-one-document.mjs --tenant <tenantId> --doc <docId> --provider <mockUrl>
 * 仅限开发/测试;不扫描其他租户/KB;不接入产品。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const env = readFileSync(path.join(repoRoot, '.env'), 'utf8')
for (const m of env.matchAll(/^(MYSQL_[A-Z_]+)=(.*)$/gm)) process.env[m[1]] = m[2]
process.env.PLATFORM_MCP_ALLOW_LOOPBACK = process.env.PLATFORM_MCP_ALLOW_LOOPBACK ?? 'true'
process.env.PLATFORM_SECRET_ENCRYPTION_KEY = process.env.PLATFORM_SECRET_ENCRYPTION_KEY ?? 'a'.repeat(64)

const args = process.argv.slice(2)
const tenantId = args[args.indexOf('--tenant') + 1]
const docId = args[args.indexOf('--doc') + 1]
const providerUrl = args[args.indexOf('--provider') + 1] ?? 'http://127.0.0.1:9098/v1'
if (!tenantId || !docId) { console.error('--tenant and --doc required'); process.exit(1) }

const { queryMany } = await import('../apps/gateway/src/db.js')
const { ragEmbeddingConfigRepository } = await import('../apps/gateway/src/repositories/rag-embedding-config-repository.js')
const { getCredentialStore } = await import('../apps/gateway/src/credentials/credential-store.js')
const { embedTexts } = await import('../apps/gateway/src/rag/embedding-client.js')
const { mysqlBlobVectorStore } = await import('../apps/gateway/src/rag/mysql-blob-vector-store.js')

const cfg = await ragEmbeddingConfigRepository.getByTenant(tenantId)
if (!cfg) { console.error('no embedding config for tenant'); process.exit(1) }
const envelope = await ragEmbeddingConfigRepository.getEnvelope(tenantId)
if (!envelope) { console.error('no api key envelope'); process.exit(1) }
const apiKey = getCredentialStore().open(envelope.toString('utf8'))

const chunks = await queryMany<{ id: string; kb_id: string; content: string }>(
  `SELECT id, kb_id AS kbId, content FROM t_dsh_knowledge_chunks WHERE doc_id = ? AND embedding IS NULL`, [docId])
console.log(`chunks to embed: ${chunks.length}`)
if (chunks.length === 0) process.exit(0)

const vectors = await embedTexts(
  { baseUrl: cfg.baseUrl, model: cfg.model, dims: cfg.dims, apiKey },
  chunks.map((c) => c.content),
  { egressPolicy: { allowedOrigins: [], allowLoopback: true } },
)
await mysqlBlobVectorStore.upsert(chunks.map((c, i) => ({
  chunkId: c.id, docId, kbId: c.kbId, tenantId,
  embedding: vectors[i] ?? [],
})))
console.log(`backfilled: ${chunks.length}`)
process.exit(0)
