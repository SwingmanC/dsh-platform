import type { TenantContext, KnowledgeBase, KbDocument, KbChunk, KbSearchInput, KbSearchResult, KbVisibility, DocStatus } from '@dsh-platform/shared'
import type { SqlValue } from '../db.js'
import { randomUUID } from 'node:crypto'
import { execute, queryMany, queryOne } from '../db.js'

interface KbRow { id: string; tenantId: string; creatorId: string; name: string; description: string | null; visibility: string; category: string | null; docCount: number; status: string; createdAt: string; updatedAt: string }
const KB_COLS = `id, tenant_id AS tenantId, creator_id AS creatorId, name, description, visibility, category, doc_count AS docCount, status, created_at AS createdAt, updated_at AS updatedAt`

interface DocRow { id: string; kbId: string; filename: string; filepath: string; fileSize: number; contentType: string | null; status: string; currentVersion: number; createdAt: string; updatedAt: string }
const DOC_COLS = `id, kb_id AS kbId, filename, filepath, file_size AS fileSize, content_type AS contentType, status, current_version AS currentVersion, created_at AS createdAt, updated_at AS updatedAt`

interface VersionRow { id: string; docId: string; version: number; content: string | null; contentHash: string | null; filepath: string | null; fileSize: number }
const VER_COLS = `id, doc_id AS docId, version, content, content_hash AS contentHash, filepath, file_size AS fileSize`

export class KnowledgeRepository {
  async listBases(ctx: TenantContext): Promise<KnowledgeBase[]> {
    const rows = await queryMany<KbRow>(
      `SELECT ${KB_COLS} FROM t_dsh_knowledge_bases
       WHERE creator_id = ? OR (visibility = 'tenant' AND tenant_id = ?)
       ORDER BY updated_at DESC`, [ctx.userId, ctx.tenantId])
    return rows.map(toKb)
  }

  async findBase(ctx: TenantContext, kbId: string): Promise<KnowledgeBase | undefined> {
    const row = await queryOne<KbRow>(
      `SELECT ${KB_COLS} FROM t_dsh_knowledge_bases
       WHERE id = ? AND (creator_id = ? OR (visibility = 'tenant' AND tenant_id = ?))`,
      [kbId, ctx.userId, ctx.tenantId])
    return row ? toKb(row) : undefined
  }

  async createBase(ctx: TenantContext, data: { name: string; description?: string; visibility?: KbVisibility; category?: string }): Promise<KnowledgeBase> {
    const id = randomUUID()
    await execute(
      `INSERT INTO t_dsh_knowledge_bases (id, tenant_id, creator_id, name, description, visibility, category) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, ctx.tenantId, ctx.userId, data.name, data.description ?? null, data.visibility ?? 'personal', data.category ?? null])
    return this.findBase(ctx, id) as unknown as KnowledgeBase
  }

  async searchDocs(ctx: TenantContext, kbId: string, q?: string): Promise<KbDocument[]> {
    const params: SqlValue[] = [kbId, ctx.userId, ctx.tenantId]
    let extra = ''
    if (q) { extra = ' AND filename LIKE ?'; params.push(`%${q}%`) }
    const rows = await queryMany<DocRow>(
      `SELECT ${DOC_COLS} FROM t_dsh_knowledge_documents
       WHERE kb_id = ? AND kb_id IN (
         SELECT id FROM t_dsh_knowledge_bases WHERE creator_id = ? OR (visibility = 'tenant' AND tenant_id = ?)
       )${extra}
       ORDER BY created_at DESC`, params)
    return rows.map(toDoc)
  }

  async addDocument(ctx: TenantContext, kbId: string, data: { filename: string; filepath: string; fileSize: number; contentType?: string }): Promise<KbDocument> {
    const id = randomUUID()
    await execute(
      `INSERT INTO t_dsh_knowledge_documents (id, kb_id, filename, filepath, file_size, content_type, status) VALUES (?, ?, ?, ?, ?, ?, 'uploaded')`,
      [id, kbId, data.filename, data.filepath, data.fileSize, data.contentType ?? null])
    await execute(`UPDATE t_dsh_knowledge_bases SET doc_count = doc_count + 1 WHERE id = ?`, [kbId])
    const doc = await queryOne<DocRow>(`SELECT ${DOC_COLS} FROM t_dsh_knowledge_documents WHERE id = ?`, [id])
    return doc ? toDoc(doc) : undefined as unknown as KbDocument
  }

  async createVersion(docId: string, data: { version: number; content: string; contentHash: string; filepath: string; fileSize: number }): Promise<void> {
    const id = randomUUID()
    await execute(
      `INSERT INTO t_dsh_knowledge_document_versions (id, doc_id, version, content, content_hash, filepath, file_size) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, docId, data.version, data.content, data.contentHash, data.filepath, data.fileSize])
    await execute(`UPDATE t_dsh_knowledge_documents SET filepath = ?, file_size = ?, content_type = 'text/plain', current_version = ? WHERE id = ?`,
      [data.filepath, data.fileSize, data.version, docId])
  }

  async createJob(kbId: string, docId: string, sourceType: string): Promise<string> {
    const id = randomUUID()
    await execute(
      `INSERT INTO t_dsh_knowledge_ingestion_jobs (id, kb_id, doc_id, source_type, status) VALUES (?, ?, ?, ?, 'pending')`,
      [id, kbId, docId, sourceType])
    return id
  }

  async updateJobStatus(jobId: string, status: string, errorMessage?: string): Promise<void> {
    if (errorMessage) {
      await execute(`UPDATE t_dsh_knowledge_ingestion_jobs SET status = ?, error_message = ? WHERE id = ?`, [status, errorMessage, jobId])
    } else {
      await execute(`UPDATE t_dsh_knowledge_ingestion_jobs SET status = ? WHERE id = ?`, [status, jobId])
    }
  }

  async listJobsForDoc(docId: string): Promise<Array<{ id: string; status: string; errorMessage: string | null }>> {
    return queryMany<{ id: string; status: string; errorMessage: string | null }>(
      `SELECT id, status, error_message AS errorMessage FROM t_dsh_knowledge_ingestion_jobs WHERE doc_id = ? ORDER BY created_at DESC`, [docId])
  }

  async addChunks(docId: string, kbId: string, chunks: { content: string; index: number }[]): Promise<void> {
    for (const c of chunks) {
      await execute(
        `INSERT INTO t_dsh_knowledge_chunks (id, doc_id, kb_id, chunk_index, content) VALUES (?, ?, ?, ?, ?)`,
        [randomUUID(), docId, kbId, c.index, c.content])
    }
    await execute(`UPDATE t_dsh_knowledge_documents SET status = 'ready' WHERE id = ?`, [docId])
  }

  async deleteChunksByDocId(docId: string): Promise<void> {
    await execute(`DELETE FROM t_dsh_knowledge_chunks WHERE doc_id = ?`, [docId])
  }

  async getBaseName(kbId: string): Promise<string | null> {
    const row = await queryOne<{ name: string }>(`SELECT name FROM t_dsh_knowledge_bases WHERE id = ?`, [kbId])
    return row?.name ?? null
  }

  async getDocFilename(docId: string): Promise<string | null> {
    const row = await queryOne<{ filename: string }>(`SELECT filename FROM t_dsh_knowledge_documents WHERE id = ?`, [docId])
    return row?.filename ?? null
  }

  searchChunks(ctx: TenantContext, input: KbSearchInput): Promise<KbSearchResult> {
    const params: SqlValue[] = [ctx.userId, ctx.tenantId, ctx.userId]
    let extra = ''
    if (input.kbId) { extra = ' AND c.kb_id = ?'; params.push(input.kbId) }
    if (input.q) { extra += ' AND c.content LIKE ?'; params.push(`%${input.q}%`) }
    const limit = Math.min(input.limit ?? 10, 50)
    const offset = input.offset ?? 0
    return this.queryChunks(`
      WHERE c.kb_id IN (
        SELECT kb_id FROM t_dsh_knowledge_mounts WHERE user_id = ?
      )
      AND c.kb_id IN (
        SELECT id FROM t_dsh_knowledge_bases
        WHERE creator_id = ? OR (visibility = 'tenant' AND tenant_id = ?)
      )
      AND c.doc_id IN (
        SELECT id FROM t_dsh_knowledge_documents WHERE status = 'ready'
      )${extra}`, params, limit, offset)
  }

  /** ACL prefiltered projection chunks(只含用户已 mount 且有权访问的 ready chunks)。 */
  async listProjectableChunks(userId: string, tenantId: string): Promise<Array<{
    chunkId: string; docId: string; kbId: string; ordinal: number; content: string; kbName: string; docFilename: string
  }>> {
    return queryMany<{ chunkId: string; docId: string; kbId: string; ordinal: number; content: string; kbName: string; docFilename: string }>(
      `SELECT c.id AS chunkId, c.doc_id AS docId, c.kb_id AS kbId, c.chunk_index AS ordinal,
              c.content, kb.name AS kbName, d.filename AS docFilename
         FROM t_dsh_knowledge_chunks c
         JOIN t_dsh_knowledge_bases kb ON kb.id = c.kb_id
         JOIN t_dsh_knowledge_documents d ON d.id = c.doc_id
         JOIN t_dsh_knowledge_mounts m ON m.kb_id = c.kb_id AND m.user_id = ?
        WHERE c.kb_id IN (
          SELECT id FROM t_dsh_knowledge_bases
          WHERE creator_id = ? OR (visibility = 'tenant' AND tenant_id = ?)
        )
          AND d.status = 'ready'
        ORDER BY c.kb_id, c.chunk_index`,
      [userId, userId, tenantId])
  }

  /** ACL prefiltered:只返回用户自己 mount 且有权访问的 ready chunks。 */
  async searchChunksForRuntime(userId: string, tenantId: string, q: string, limit: number): Promise<Array<{
    chunkId: string; docId: string; kbId: string; ordinal: number; content: string; score: number; kbName: string; docFilename: string
  }>> {
    const like = `%${q}%`
    return queryMany<{ chunkId: string; docId: string; kbId: string; ordinal: number; content: string; score: number; kbName: string; docFilename: string }>(
      `SELECT c.id AS chunkId, c.doc_id AS docId, c.kb_id AS kbId, c.chunk_index AS ordinal,
              c.content,
              (LENGTH(c.content) - LENGTH(REPLACE(LOWER(c.content), LOWER(?), ''))) / LENGTH(?) AS score,
              kb.name AS kbName, d.filename AS docFilename
         FROM t_dsh_knowledge_chunks c
         JOIN t_dsh_knowledge_bases kb ON kb.id = c.kb_id
         JOIN t_dsh_knowledge_documents d ON d.id = c.doc_id
         JOIN t_dsh_knowledge_mounts m ON m.kb_id = c.kb_id AND m.user_id = ?
        WHERE c.content LIKE ?
          AND c.kb_id IN (
            SELECT id FROM t_dsh_knowledge_bases
            WHERE creator_id = ? OR (visibility = 'tenant' AND tenant_id = ?)
          )
          AND d.status = 'ready'
        ORDER BY score DESC
        LIMIT ?`,
      [q, q, userId, like, userId, tenantId, limit])
  }

  async getChunkById(chunkId: string): Promise<{ content: string; docId: string; kbId: string } | null> {
    const row = await queryOne<{ content: string; docId: string; kbId: string }>(
      `SELECT content, doc_id AS docId, kb_id AS kbId FROM t_dsh_knowledge_chunks WHERE id = ?`, [chunkId])
    return row ?? null
  }

  async listMountedKbIds(userId: string): Promise<string[]> {
    const rows = await queryMany<{ kbId: string }>(`SELECT kb_id AS kbId FROM t_dsh_knowledge_mounts WHERE user_id = ?`, [userId])
    return rows.map((r) => r.kbId)
  }

  async mount(ctx: TenantContext, kbId: string): Promise<boolean> {
    const id = randomUUID()
    await execute(`INSERT IGNORE INTO t_dsh_knowledge_mounts (id, user_id, kb_id, mount_type) VALUES (?, ?, ?, 'user')`, [id, ctx.userId, kbId])
    return true
  }

  async unmount(ctx: TenantContext, kbId: string): Promise<boolean> {
    const affected = await execute(`DELETE FROM t_dsh_knowledge_mounts WHERE user_id = ? AND kb_id = ?`, [ctx.userId, kbId])
    return affected > 0
  }

  async listMounts(ctx: TenantContext): Promise<KnowledgeBase[]> {
    const rows = await queryMany<KbRow>(
      `SELECT ${KB_COLS} FROM t_dsh_knowledge_bases
       WHERE id IN (SELECT kb_id FROM t_dsh_knowledge_mounts WHERE user_id = ?)
       ORDER BY updated_at DESC`, [ctx.userId])
    return rows.map(toKb)
  }

  private async queryChunks(whereClause: string, params: SqlValue[], limit: number, offset: number): Promise<KbSearchResult> {
    const countRow = await queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM t_dsh_knowledge_chunks c ${whereClause}`, params)
    const rows = await queryMany<KbChunk>(
      `SELECT c.id, c.doc_id AS docId, c.kb_id AS kbId, c.chunk_index AS chunkIndex, c.content, c.token_count AS tokenCount, c.created_at AS createdAt
       FROM t_dsh_knowledge_chunks c ${whereClause} ORDER BY c.kb_id, c.chunk_index LIMIT ? OFFSET ?`,
      [...params, limit, offset])
    return { chunks: rows, total: countRow?.total ?? 0 }
  }
}

function toKb(r: KbRow): KnowledgeBase {
  return { ...r, visibility: r.visibility as KbVisibility, docCount: r.docCount ?? 0, status: r.status ?? 'active' }
}
function toDoc(r: DocRow): KbDocument {
  return { ...r, status: r.status as DocStatus, fileSize: r.fileSize ?? 0, currentVersion: r.currentVersion ?? 1 }
}

export const knowledgeRepository = new KnowledgeRepository()