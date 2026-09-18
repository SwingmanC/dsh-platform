import type { TenantContext, KbSearchInput, KbSearchResult, KnowledgeBase, KbDocument, KbVisibility } from '@dsh-platform/shared'
import { knowledgeRepository } from '../repositories/knowledge-repository.js'
import { storeUploadedDocument } from '../knowledge-storage.js'
import { extractText, chunkDocument } from '../ingestion.js'
import { writeKnowledgeProjection } from '../knowledge-projection.js'

const ALLOWED_MIME: ReadonlySet<string> = new Set(['text/plain', 'text/markdown', 'text/x-markdown'])
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
    const text = extractText(buffer, resolvedMime)
    await knowledgeRepository.createVersion(doc.id, {
      version: doc.currentVersion, content: text, contentHash: stored.contentHash,
      filepath: stored.versionId, fileSize: stored.bytes,
    })
    const jobId = await knowledgeRepository.createJob(kbId, doc.id, 'upload')
    try {
      await knowledgeRepository.updateJobStatus(jobId, 'parsing')
      await knowledgeRepository.deleteChunksByDocId(doc.id)
      const chunks = chunkDocument(text)
      await knowledgeRepository.updateJobStatus(jobId, 'chunking')
      await knowledgeRepository.addChunks(doc.id, kbId, chunks.map((c) => ({ content: c.content, index: c.index })))
      await knowledgeRepository.updateJobStatus(jobId, 'ready')
    } catch (err) {
      await knowledgeRepository.updateJobStatus(jobId, 'failed', (err as Error).message)
      throw err
    }
    return doc
  }

  async search(ctx: TenantContext, input: KbSearchInput): Promise<KbSearchResult> {
    return knowledgeRepository.searchChunks(ctx, input)
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
}

export const knowledgeService = new KnowledgeService()