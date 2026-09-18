import type { TenantContext, MemoryRecord, MemorySearchInput, MemorySearchResult, MemoryVisibility, MemorySourceType } from '@dsh-platform/shared'
import type { SqlValue } from '../db.js'
import { createHash, randomUUID } from 'node:crypto'
import { execute, queryMany, queryOne } from '../db.js'

interface MemoryRow {
  id: string
  tenantId: string
  ownerUserId: string
  namespace: string
  content: string
  kind: string
  contentHash: string | null
  visibility: string
  sourceType: string
  sourceSessionId: string | null
  sourceEventSeq: number | null
  confidence: number | null
  revision: number
  supersededBy: string | null
  extractionMode: string
  updatedBy: string | null
  reviewStatus: string
  reviewedBy: string | null
  createdAt: string
  updatedAt: string
}

const COLUMNS = `id, tenant_id AS tenantId, owner_user_id AS ownerUserId, namespace,
  content, kind, content_hash AS contentHash, visibility, source_type AS sourceType,
  source_session_id AS sourceSessionId, source_event_seq AS sourceEventSeq, confidence,
  revision, superseded_by AS supersededBy, extraction_mode AS extractionMode,
  updated_by AS updatedBy, review_status AS reviewStatus, reviewed_by AS reviewedBy,
  created_at AS createdAt, updated_at AS updatedAt`

export interface CreateMemoryInput {
  tenantId: string
  ownerUserId: string
  namespace: string
  content: string
  kind: string
  visibility: MemoryVisibility
  sourceType: MemorySourceType
  sourceSessionId: string | null
  sourceEventSeq: number | null
  confidence: number | null
  extractionMode: string
  reviewStatus: string
}

export function contentHashOf(content: string): string {
  return createHash('sha256').update(content.trim().toLowerCase()).digest('hex')
}

export class MemoryRepository {
  async create(record: CreateMemoryInput): Promise<MemoryRecord> {
    const id = randomUUID()
    const contentHash = contentHashOf(record.content)
    await execute(
      `INSERT INTO t_dsh_memory_records
       (id, tenant_id, owner_user_id, namespace, content, kind, content_hash, visibility, source_type,
        source_session_id, source_event_seq, confidence, revision, extraction_mode, updated_by, review_status, reviewed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [id, record.tenantId, record.ownerUserId, record.namespace, record.content, record.kind, contentHash,
       record.visibility, record.sourceType, record.sourceSessionId, record.sourceEventSeq, record.confidence,
       record.extractionMode, record.ownerUserId, record.reviewStatus, null],
    )
    return (await this.findByIdRaw(id)) as MemoryRecord
  }

  /** 幂等:相同 content_hash + kind + namespace + owner 的未删除 active 记录。 */
  async findByContentHash(ownerUserId: string, contentHash: string, kind: string, namespace: string): Promise<MemoryRecord | undefined> {
    const row = await queryOne<MemoryRow>(
      `SELECT ${COLUMNS} FROM t_dsh_memory_records
        WHERE owner_user_id = ? AND content_hash = ? AND kind = ? AND namespace = ?
          AND deleted_at IS NULL AND superseded_by IS NULL
        ORDER BY updated_at DESC LIMIT 1`,
      [ownerUserId, contentHash, kind, namespace])
    return row ? toRecord(row) : undefined
  }

  async findByIdRaw(memoryId: string): Promise<MemoryRecord | undefined> {
    const row = await queryOne<MemoryRow>(`SELECT ${COLUMNS} FROM t_dsh_memory_records WHERE id = ?`, [memoryId])
    return row ? toRecord(row) : undefined
  }

  async search(ctx: TenantContext, input: MemorySearchInput): Promise<MemorySearchResult> {
    const conditions: string[] = ['tenant_id = ?', 'deleted_at IS NULL', 'superseded_by IS NULL']
    const params: SqlValue[] = [ctx.tenantId]

    if (input.visibility === 'personal') {
      conditions.push('owner_user_id = ? AND visibility = ?')
      params.push(ctx.userId, 'personal')
    } else if (input.visibility === 'tenant_shared') {
      conditions.push("visibility = 'tenant_shared'")
    } else {
      conditions.push('(owner_user_id = ? OR visibility = ?)')
      params.push(ctx.userId, 'tenant_shared')
    }
    if (input.namespace) { conditions.push('namespace = ?'); params.push(input.namespace) }
    if (input.kind) { conditions.push('kind = ?'); params.push(input.kind) }
    if (input.query && input.query.trim() !== '') {
      conditions.push('content LIKE ?')
      params.push(`%${input.query.trim()}%`)
    }

    const limit = Math.min(input.limit ?? 20, 100)
    const offset = input.offset ?? 0
    const countRow = await queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM t_dsh_memory_records WHERE ${conditions.join(' AND ')}`, params)
    const rows = await queryMany<MemoryRow>(
      `SELECT ${COLUMNS} FROM t_dsh_memory_records WHERE ${conditions.join(' AND ')}
       ORDER BY updated_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset])
    return { records: rows.map(toRecord), total: countRow?.total ?? 0 }
  }

  /** ACL prefiltered runtime 检索:先 SQL 约束,再 lexical scoring。 */
  async searchForRuntime(
    userId: string, tenantId: string, query: string, kind: string | undefined, limit: number,
    includeTeam: boolean,
  ): Promise<Array<{ id: string; kind: string; content: string; scope: string; namespace: string; updatedAt: string; score: number }>> {
    const like = `%${query}%`
    const conditions: string[] = [
      'tenant_id = ?', 'deleted_at IS NULL', 'superseded_by IS NULL', "review_status = 'approved'",
    ]
    const params: SqlValue[] = [tenantId]
    if (includeTeam) {
      conditions.push('(owner_user_id = ? OR visibility = ?)')
      params.push(userId, 'tenant_shared')
    } else {
      conditions.push('owner_user_id = ? AND visibility = ?')
      params.push(userId, 'personal')
    }
    if (kind) { conditions.push('kind = ?'); params.push(kind) }
    conditions.push('content LIKE ?'); params.push(like)

    return queryMany<{ id: string; kind: string; content: string; scope: string; namespace: string; updatedAt: string; score: number }>(
      `SELECT id, kind, content, visibility AS scope, namespace, updated_at AS updatedAt,
              (LENGTH(LOWER(content)) - LENGTH(REPLACE(LOWER(content), LOWER(?), ''))) / LENGTH(?) AS score
         FROM t_dsh_memory_records
        WHERE ${conditions.join(' AND ')}
        ORDER BY score DESC, updated_at DESC
        LIMIT ?`,
      [query, query, ...params, limit])
  }

  /** 投影:该用户 personal(可选 team)未删除 active memories。 */
  async listProjectable(userId: string, tenantId: string): Promise<Array<{
    id: string; kind: string; content: string; visibility: string; namespace: string;
    revision: number; sourceType: string; extractionMode: string; sourceSessionId: string | null; updatedAt: string
  }>> {
    return queryMany<{ id: string; kind: string; content: string; visibility: string; namespace: string; revision: number; sourceType: string; extractionMode: string; sourceSessionId: string | null; updatedAt: string }>(
      `SELECT id, kind, content, visibility, namespace, revision, source_type AS sourceType,
              extraction_mode AS extractionMode, source_session_id AS sourceSessionId, updated_at AS updatedAt
         FROM t_dsh_memory_records
        WHERE tenant_id = ? AND owner_user_id = ? AND visibility = 'personal'
          AND deleted_at IS NULL AND superseded_by IS NULL AND review_status = 'approved'
        ORDER BY updated_at DESC
        LIMIT 500`,
      [tenantId, userId])
  }

  async findById(ctx: TenantContext, memoryId: string): Promise<MemoryRecord | undefined> {
    const row = await queryOne<MemoryRow>(
      `SELECT ${COLUMNS} FROM t_dsh_memory_records
        WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND (owner_user_id = ? OR visibility = ?)`,
      [memoryId, ctx.tenantId, ctx.userId, 'tenant_shared'])
    return row ? toRecord(row) : undefined
  }

  async findOwned(ctx: TenantContext, memoryId: string): Promise<MemoryRecord | undefined> {
    const row = await queryOne<MemoryRow>(
      `SELECT ${COLUMNS} FROM t_dsh_memory_records
        WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND deleted_at IS NULL`,
      [memoryId, ctx.tenantId, ctx.userId])
    return row ? toRecord(row) : undefined
  }

  /** soft delete(保留审计链)。 */
  async delete(ctx: TenantContext, memoryId: string): Promise<boolean> {
    const affected = await execute(
      `UPDATE t_dsh_memory_records SET deleted_at = UTC_TIMESTAMP(3), updated_by = ?
        WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND deleted_at IS NULL`,
      [ctx.userId, memoryId, ctx.tenantId, ctx.userId])
    return affected > 0
  }

  /** Runtime 写回(已由 internal channel 解析出 userId/tenantId)。 */
  async softDeleteByOwner(memoryId: string, userId: string, tenantId: string): Promise<boolean> {
    const affected = await execute(
      `UPDATE t_dsh_memory_records SET deleted_at = UTC_TIMESTAMP(3), updated_by = ?
        WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND deleted_at IS NULL`,
      [userId, memoryId, tenantId, userId])
    return affected > 0
  }

  async updateVisibility(ctx: TenantContext, memoryId: string, visibility: MemoryVisibility): Promise<boolean> {
    const affected = await execute(
      `UPDATE t_dsh_memory_records SET visibility = ?, updated_by = ?
        WHERE id = ? AND tenant_id = ? AND owner_user_id = ? AND deleted_at IS NULL`,
      [visibility, ctx.userId, memoryId, ctx.tenantId, ctx.userId])
    return affected > 0
  }

  /** 冲突:旧记录 superseded,新记录 active。 */
  async supersede(oldId: string, newId: string): Promise<void> {
    await execute(`UPDATE t_dsh_memory_records SET superseded_by = ? WHERE id = ?`, [newId, oldId])
  }
}

function toRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ownerUserId: row.ownerUserId,
    namespace: row.namespace,
    content: row.content,
    kind: row.kind as MemoryRecord['kind'],
    visibility: row.visibility as MemoryVisibility,
    sourceType: row.sourceType as MemorySourceType,
    sourceSessionId: row.sourceSessionId,
    sourceEventSeq: row.sourceEventSeq,
    confidence: row.confidence,
    revision: row.revision,
    supersededBy: row.supersededBy,
    extractionMode: row.extractionMode as MemoryRecord['extractionMode'],
    reviewStatus: row.reviewStatus as MemoryRecord['reviewStatus'],
    reviewedBy: row.reviewedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export const memoryRepository = new MemoryRepository()