import type { TenantContext, KbChunk, KbSearchInput, KbSearchResult, KnowledgeBase, KbDocument, KbVisibility } from '@dsh-platform/shared'
import { knowledgeRepository } from '../repositories/knowledge-repository.js'
import { ragEmbeddingConfigRepository } from '../repositories/rag-embedding-config-repository.js'
import { getCredentialStore } from '../credentials/credential-store.js'
import { storeUploadedDocument } from '../knowledge-storage.js'
import { extractTextFromBuffer, chunkDocument } from '../ingestion.js'
import { writeKnowledgeProjection } from '../knowledge-projection.js'
import { embedTexts, EmbeddingProviderError } from '../rag/embedding-client.js'
import { mysqlBlobVectorStore } from '../rag/mysql-blob-vector-store.js'
import { rrfFuse } from '../rag/hybrid.js'
import { buildCitationId, parseCitationId } from '../rag/citation.js'
import { validateEgressUrl } from '../egress.js'
import { config } from '../config.js'

const ADMIN_ROLES: ReadonlySet<string> = new Set(['tenant_admin', 'operator'])
// K-T6-lite 检索参数(简单常量,不建立复杂配置系统)。
const HYBRID_KEYWORD_TOP_K = 20
const HYBRID_VECTOR_TOP_K = 20
const HYBRID_FINAL_TOP_K = 6
const RRF_K = 60

/** K-T3:embedding 配置为租户级管理面,仅管理员(普通用户 403)。 */
export function isTenantAdminRole(role: string): boolean {
  return ADMIN_ROLES.has(role)
}

/** GET 配置视图:永不包含 envelope/明文 key;仅 hasKey + 尾 4 位 hint。 */
export interface EmbeddingConfigView {
  provider: string
  baseUrl: string
  model: string
  dims: number
  hasKey: boolean
  keyHint: string | null
  lastTestAt: string | null
  lastError: string | null
}

/** K-T6-FINAL:runtime knowledge_search 输出(工具既有结果形态 + 可选模式标注;K-T7 附 citation)。 */
export interface RuntimeSearchResult {
  results: Array<{
    chunkId: string; snippet: string; knowledgeBase: string; documentTitle: string; score: number
    citation?: { citationId: string; kbId: string; documentId: string; documentVersionId: string; chunkId: string; chunkIndex: number; documentTitle: string }
  }>
  retrievalMode: 'keyword' | 'hybrid' | 'vector'
  vectorFallbackReason?: string
}

/** 从行构造视图(纯函数,便于单测:断言响应不含明文/envelope)。 */
export function embeddingConfigToView(row: {
  provider: string; baseUrl: string; model: string; dims: number; keyHint: string; lastTestAt: string | null; lastError: string | null
}, hasKey: boolean): EmbeddingConfigView {
  return {
    provider: row.provider,
    baseUrl: row.baseUrl,
    model: row.model,
    dims: row.dims,
    hasKey,
    keyHint: hasKey && row.keyHint !== '' ? row.keyHint : null,
    lastTestAt: row.lastTestAt,
    lastError: row.lastError,
  }
}

const ALLOWED_MIME: ReadonlySet<string> = new Set([
  'text/plain', 'text/markdown', 'text/x-markdown',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])
const UPLOAD_MAX_BYTES = 20 * 1024 * 1024

export class KnowledgeService {
  async listBases(ctx: TenantContext): Promise<KnowledgeBase[]> {
    return knowledgeRepository.listBases(ctx)
  }

  async createBase(ctx: TenantContext, data: { name: string; description?: string; visibility?: string; category?: string }): Promise<KnowledgeBase> {
    return knowledgeRepository.createBase(ctx, {
      name: data.name, description: data.description,
      visibility: data.visibility as KbVisibility, category: data.category,
    })
  }

  async listDocuments(ctx: TenantContext, kbId: string): Promise<KbDocument[]> {
    return knowledgeRepository.searchDocs(ctx, kbId)
  }

  async uploadDocument(ctx: TenantContext, kbId: string, filename: string, mime: string, buffer: Buffer): Promise<KbDocument> {
    const kb = await knowledgeRepository.findBase(ctx, kbId)
    if (!kb) throw new Error('knowledge-base-not-found')
    const ext = filename.split('.').pop()?.toLowerCase() ?? ''
    const mimeFromExt: Record<string, string> = { md: 'text/markdown', txt: 'text/plain', text: 'text/plain' }
    const resolvedMime = mimeFromExt[ext] ?? mime
    if (!ALLOWED_MIME.has(resolvedMime)) throw new Error(`unsupported-mime: ${resolvedMime}`)
    if (buffer.length > UPLOAD_MAX_BYTES) throw new Error('document-too-large')
    const safeName = filename.replace(/[\\/:*?"<>|\0]/g, '_').slice(0, 256)
    const doc = await knowledgeRepository.addDocument(ctx, kbId, { filename: safeName, filepath: '', fileSize: buffer.length, contentType: resolvedMime })
    const stored = await storeUploadedDocument(ctx.tenantId, kbId, doc.id, buffer, resolvedMime, safeName)
    const jobId = await knowledgeRepository.createJob(kbId, doc.id, 'upload')
    try {
      await knowledgeRepository.updateJobStatus(jobId, 'parsing')
      // 解析失败(pdf/docx 损坏或无文本层)同样落入本失败处理:doc=failed + job.error_message。
      const text = await extractTextFromBuffer(buffer, resolvedMime)
      await knowledgeRepository.createVersion(doc.id, {
        version: doc.currentVersion, content: text, contentHash: stored.contentHash,
        filepath: stored.versionId, fileSize: stored.bytes,
      })
      await knowledgeRepository.deleteChunksByDocId(doc.id)
      const chunks = chunkDocument(text)
      await knowledgeRepository.updateJobStatus(jobId, 'chunking')
      const createdChunks = await knowledgeRepository.addChunks(doc.id, kbId, chunks.map((c) => ({ content: c.content, index: c.index })))
      // --- K-T5-lite:自动 embedding(chunks 已持久化;失败不破坏 keyword 检索) ---
      // §10:租户无 embedding 配置 → 跳过(embedding 保持 NULL),上传仍成功;
      // §11:provider 失败(超时/401/维度)→ 保留 chunks 与 ready 状态,受控诊断码写 job.error_message。
      let embeddingError: string | undefined
      try {
        const embCfg = await ragEmbeddingConfigRepository.getByTenant(ctx.tenantId)
        if (embCfg !== undefined) {
          const embEnvelope = await ragEmbeddingConfigRepository.getEnvelope(ctx.tenantId)
          if (embEnvelope === null) throw new EmbeddingProviderError('no-api-key')
          const embApiKey = getCredentialStore().open(embEnvelope.toString('utf8'))
          const vectors = await embedTexts(
            { baseUrl: embCfg.baseUrl, model: embCfg.model, dims: embCfg.dims, apiKey: embApiKey },
            createdChunks.map((c) => chunks.find((ch) => ch.index === c.index)?.content ?? ''),
            { egressPolicy: { allowedOrigins: config.mcp.allowedOrigins, allowLoopback: config.mcp.allowLoopback } },
          )
          await mysqlBlobVectorStore.upsert(createdChunks.map((c, i) => ({
            chunkId: c.id, docId: doc.id, kbId, tenantId: ctx.tenantId, embedding: vectors[i] ?? [],
          })))
        }
      } catch (embErr) {
        embeddingError = embErr instanceof EmbeddingProviderError ? embErr.code : 'embedding-index-failed'
        process.stderr.write(`[kt5-lite] embedding index failed: ${embeddingError}\n${(embErr as Error)?.stack ?? String(embErr)}\n`)
      }
      await knowledgeRepository.updateJobStatus(jobId, 'ready', embeddingError)
    } catch (err) {
      // K-T1:失败只影响当前文档。错误码由解析层受控产生(无 stack/路径/secret,长度受控)。
      const msg = (err as Error).message.slice(0, 200)
      await knowledgeRepository.updateJobStatus(jobId, 'failed', msg)
      await knowledgeRepository.updateDocumentStatus(doc.id, 'failed')
      throw err
    }
    return doc
  }

  async search(ctx: TenantContext, input: KbSearchInput & { mode?: string }): Promise<KbSearchResult & {
    retrievalMode: 'keyword' | 'hybrid' | 'vector'
    vectorFallbackReason?: string
  }> {
    // 1) keyword path(LIKE,既有实现不变,始终参与/兜底)
    const keyword = await knowledgeRepository.searchChunks(ctx, { ...input, limit: input.limit ?? HYBRID_KEYWORD_TOP_K })
    // K-T7:两路结果统一附带 citation metadata(不改排序/融合/topK)
    await this.attachCitations(keyword.chunks)
    const mode = input.mode === 'keyword' ? 'keyword' : 'hybrid'
    if (mode === 'keyword') return { ...keyword, retrievalMode: 'keyword' }

    // 2) vector path(可用性层层降级;任何失败 → fallback keyword,检索永不失败)
    let vectorRanked: Array<{ chunkId: string; content: unknown; docId: string; kbId: string; chunkIndex: number }> = []
    let fallbackReason: string | undefined
    try {
      const row = await ragEmbeddingConfigRepository.getByTenant(ctx.tenantId)
      if (row === undefined) fallbackReason = 'no-embedding-config'
      else {
        const envelope = await ragEmbeddingConfigRepository.getEnvelope(ctx.tenantId)
        if (envelope === null) fallbackReason = 'no-api-key'
        else {
          let apiKey = ''
          try {
            apiKey = getCredentialStore().open(envelope.toString('utf8'))
          } catch {
            fallbackReason = 'decrypt-failed'
          }
          if (fallbackReason === undefined && apiKey !== '') {
            const chunks = await knowledgeRepository.listProjectableChunks(ctx.userId, ctx.tenantId)
            // kbId 语义保留:限定单一 KB 时,scope 仅含该 KB 的 chunk
            const allowed = (input.kbId !== undefined
              ? chunks.filter((c) => c.kbId === input.kbId)
              : chunks).map((c) => c.chunkId)
            if (allowed.length === 0) fallbackReason = 'no-allowed-chunks'
            else {
              const qv = await embedTexts(
                { baseUrl: row.baseUrl, model: row.model, dims: row.dims, apiKey },
                [input.q],
                { egressPolicy: { allowedOrigins: config.mcp.allowedOrigins, allowLoopback: config.mcp.allowLoopback } },
              )
              const hits = await mysqlBlobVectorStore.search(
                qv[0]!, { tenantId: ctx.tenantId, allowedChunkIds: allowed }, HYBRID_VECTOR_TOP_K)
              // vector 命中映射为融合输入(与 KbChunk 兼容的最小形态)
              const byId = new Map(hits.map((h) => [h.chunkId, h]))
              const chunkRows = await knowledgeRepository.getChunksByIds(hits.map((h) => h.chunkId))
              // K-T7:vector 命中同样附带 citation metadata
              await this.attachCitations(chunkRows as unknown as KbChunk[])
              for (const row2 of chunkRows) {
                const hit = byId.get(row2.id)
                if (hit === undefined) continue
                vectorRanked.push({ ...row2, chunkId: row2.id })
              }
              if (vectorRanked.length === 0) fallbackReason = 'no-embedded-chunks'
            }
          }
        }
      }
    } catch (err) {
      // provider/网络/维度等任何异常:检索不失败,降级 keyword(受控诊断,不暴露 provider 细节)
      fallbackReason = err instanceof EmbeddingProviderError ? err.code : 'vector-search-error'
      process.stderr.write(`[kt6] vector path fallback: ${fallbackReason}\n`)
    }

    // 3) fusion(向量不可用时即为 keyword 排序,行为等同现状)
    if (vectorRanked.length === 0) {
      return { ...keyword, retrievalMode: 'keyword', vectorFallbackReason: fallbackReason }
    }
    const fused = rrfFuse(
      keyword.chunks.map((c) => ({ ...c, chunkId: c.id })),
      vectorRanked,
      { k: RRF_K, topK: HYBRID_FINAL_TOP_K },
    )
    return {
      chunks: fused.map((f) => f.chunk as unknown as KbChunk),
      total: fused.length,
      retrievalMode: 'hybrid',
    }
  }

  /**
   * K-T6-FINAL:Runtime knowledge_search 的 Gateway seam。
   *
   * - 身份:调用方(admin 路由)必须先经 `x-runtime-token` 解析出 userId/tenantId
   *   (internal-channel ephemeral token),**不得**采信请求体身份字段;
   * - 检索:完全复用 `search`(keyword + vector + RRF + 自动 fallback),无第二套实现;
   * - 输出:映射为 runtime tool 既有结果形态(chunkId/snippet/knowledgeBase/documentTitle/score),
   *   score 为融合排名归一值(RRF 分数不外泄,保持工具输出契约稳定)。
   */
  async searchForRuntime(
    identity: { userId: string; tenantId: string },
    input: { query: string; knowledgeBase?: string; limit?: number },
  ): Promise<RuntimeSearchResult> {
    const ctx: TenantContext = {
      tenantId: identity.tenantId, userId: identity.userId, role: 'member',
      requestId: '', platformSessionId: '', deviceId: '',
    }
    let kbId: string | undefined
    if (input.knowledgeBase !== undefined && input.knowledgeBase !== '') {
      kbId = (await knowledgeRepository.findBaseIdByName(identity.tenantId, input.knowledgeBase)) ?? undefined
      if (kbId === undefined) return { results: [], retrievalMode: 'hybrid' }
    }
    const limit = Math.min(Math.max(input.limit ?? 5, 1), 20)
    const r = await this.search(ctx, { q: input.query, kbId, limit, mode: 'hybrid' })
    const results: Array<{ chunkId: string; snippet: string; knowledgeBase: string; documentTitle: string; score: number }> = []
    for (let i = 0; i < r.chunks.length; i += 1) {
      const c = r.chunks[i]!
      const [kbName, docTitle] = await Promise.all([
        knowledgeRepository.getKbName(c.kbId),
        knowledgeRepository.getDocFilename(c.docId),
      ])
      results.push({
        chunkId: c.id,
        snippet: c.content,
        knowledgeBase: kbName ?? c.kbId,
        documentTitle: docTitle ?? '(unknown)',
        score: Number(((r.chunks.length - i) / r.chunks.length).toFixed(4)),
        ...(c.citation !== undefined ? { citation: c.citation } : {}),
      })
    }
    const out: RuntimeSearchResult = {
      results, retrievalMode: r.retrievalMode,
    }
    if (r.vectorFallbackReason !== undefined) out.vectorFallbackReason = r.vectorFallbackReason
    return out
  }

  /** K-T7:为 chunk 列表附加稳定 citation metadata(不改变排序/内容)。 */
  private async attachCitations(chunks: KbChunk[]): Promise<void> {
    const docIds = [...new Set(chunks.map((c) => c.docId))]
    const versionMap = await knowledgeRepository.getVersionIdMap(docIds)
    const filenameMap = await knowledgeRepository.getDocFilenameMap(docIds)
    for (const c of chunks) {
      const versionId = versionMap.get(c.docId)
      if (versionId === undefined) continue // 版本行缺失(异常数据):缺省 citation,不伪造
      c.citation = {
        citationId: buildCitationId({ kbId: c.kbId, docId: c.docId, versionId, chunkId: c.id }),
        kbId: c.kbId, documentId: c.docId, documentVersionId: versionId, chunkId: c.id, chunkIndex: c.chunkIndex,
        documentTitle: filenameMap.get(c.docId) ?? '(unknown)',
      }
    }
  }

  /**
   * K-T7:citation resolve —— 硬性 ACL 重校验。
   * 解析 → 加载 → ACL(mount + ready + 可见性/creator + 版本一致)→ 返回;任一失败 → null(404)。
   * citationId 绝不作为绕过 ACL 的读取凭据。
   */
  async resolveCitation(ctx: TenantContext, citationId: string): Promise<{
    citationId: string; kbId: string; kbName: string; documentId: string
    documentTitle: string; documentVersionId: string; chunkId: string; chunkIndex: number; snippet: string
  } | null> {
    const parts = parseCitationId(citationId)
    if (parts === null) throw new Error('invalid-citation-id')
    const row = await knowledgeRepository.findCitationChunk(ctx, parts)
    if (row === undefined) return null
    return {
      citationId: buildCitationId({ kbId: row.kbId, docId: row.documentId, versionId: row.documentVersionId, chunkId: row.chunkId }),
      kbId: row.kbId, kbName: row.kbName, documentId: row.documentId,
      documentTitle: row.documentTitle, documentVersionId: row.documentVersionId,
      chunkId: row.chunkId, chunkIndex: row.chunkIndex, snippet: row.snippet,
    }
  }

  async mount(ctx: TenantContext, kbId: string): Promise<boolean> {
    const ok = await knowledgeRepository.mount(ctx, kbId)
    return ok
  }

  async unmount(ctx: TenantContext, kbId: string): Promise<boolean> {
    return knowledgeRepository.unmount(ctx, kbId)
  }

  async listMounts(ctx: TenantContext): Promise<KnowledgeBase[]> {
    return knowledgeRepository.listMounts(ctx)
  }

  /** 构建某用户的 Knowledge projection(每用户 ACL 预过滤的 chunk refs)。 */
  async buildProjection(userId: string, tenantId: string): Promise<void> {
    const chunks = await knowledgeRepository.listProjectableChunks(userId, tenantId)
    const mountedIds = await knowledgeRepository.listMountedKbIds(userId)
    await writeKnowledgeProjection(tenantId, userId, {
      chunks: chunks.map((c) => ({
        chunkId: c.chunkId, docId: c.docId, kbId: c.kbId,
        kbName: c.kbName, documentTitle: c.docFilename,
        ordinal: c.ordinal, snippet: c.content.slice(0, 200),
        score: 0,
      })),
      mountedKbIds: mountedIds,
    })
  }

  // --- K-T3:Embedding Provider 配置(租户级;仅管理员) ---

  async getEmbeddingConfig(ctx: TenantContext): Promise<EmbeddingConfigView | null> {
    if (!isTenantAdminRole(ctx.role)) throw new Error('forbidden')
    const row = await ragEmbeddingConfigRepository.getByTenant(ctx.tenantId)
    if (row === undefined) return null
    const hasKey = (await ragEmbeddingConfigRepository.getEnvelope(ctx.tenantId)) !== null
    return embeddingConfigToView(row, hasKey)
  }

  /**
   * 保存配置(每次 PUT 都需要提供 apiKey —— 无“留空保留旧 key”的歧义语义;
   * provider 第一阶段固定 openai-compatible;base_url 过 egress SSRF 校验)。
   */
  async saveEmbeddingConfig(
    ctx: TenantContext,
    input: { provider: string; baseUrl: string; model: string; dims: number; apiKey: string },
  ): Promise<EmbeddingConfigView> {
    if (!isTenantAdminRole(ctx.role)) throw new Error('forbidden')
    if (input.provider !== 'openai-compatible') throw new Error('unsupported-provider')
    if (input.model.trim() === '' || !Number.isInteger(input.dims) || input.dims <= 0) throw new Error('invalid-config')
    if (input.apiKey.trim() === '') throw new Error('empty-api-key')
    // egress SSRF 校验(沿用平台 MCP outbound policy);不通过则不入库。
    const egress = { allowedOrigins: config.mcp.allowedOrigins, allowLoopback: config.mcp.allowLoopback }
    const v = validateEgressUrl(input.baseUrl, egress)
    if (!v.ok) throw new Error(`embedding-config-invalid:${v.reason}`)
    const envelope = Buffer.from(getCredentialStore().seal(input.apiKey.trim()), 'utf8')
    const keyHint = input.apiKey.trim().slice(-4)
    await ragEmbeddingConfigRepository.upsert(ctx.tenantId, {
      provider: input.provider, baseUrl: input.baseUrl.trim(), model: input.model.trim(),
      dims: input.dims, envelope, keyHint,
    })
    const row = await ragEmbeddingConfigRepository.getByTenant(ctx.tenantId)
    if (row === undefined) throw new Error('save-failed')
    return embeddingConfigToView(row, true)
  }

  /** 连接测试:服务端解密 key → 调 1 条固定无敏感文本 → 校验维度;不启用任何检索行为。 */
  async testEmbeddingConfig(ctx: TenantContext): Promise<{
    ok: true; provider: string; model: string; dims: number; latencyMs: number
  } | { ok: false; code: string }> {
    if (!isTenantAdminRole(ctx.role)) throw new Error('forbidden')
    const row = await ragEmbeddingConfigRepository.getByTenant(ctx.tenantId)
    if (row === undefined) throw new Error('embedding-config-not-found')
    const envelope = await ragEmbeddingConfigRepository.getEnvelope(ctx.tenantId)
    if (envelope === null) throw new Error('embedding-config-not-found')
    let apiKey: string
    try {
      apiKey = getCredentialStore().open(envelope.toString('utf8'))
    } catch {
      await ragEmbeddingConfigRepository.markTest(ctx.tenantId, false, 'decrypt-failed')
      throw new Error('decrypt-failed')
    }
    const started = Date.now()
    try {
      await embedTexts(
        { baseUrl: row.baseUrl, model: row.model, dims: row.dims, apiKey },
        ['CMCC_EMBEDDING_CONNECTION_TEST'],
        { egressPolicy: { allowedOrigins: config.mcp.allowedOrigins, allowLoopback: config.mcp.allowLoopback } },
      )
    } catch (err) {
      const code = err instanceof EmbeddingProviderError ? err.code : 'provider-error:unknown'
      await ragEmbeddingConfigRepository.markTest(ctx.tenantId, false, code)
      return { ok: false, code }
    }
    const latencyMs = Date.now() - started
    await ragEmbeddingConfigRepository.markTest(ctx.tenantId, true)
    return { ok: true, provider: row.provider, model: row.model, dims: row.dims, latencyMs }
  }
}

export const knowledgeService = new KnowledgeService()