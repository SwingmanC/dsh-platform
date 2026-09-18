import type { TenantContext, MemoryRecord, MemorySearchInput, MemorySearchResult, PromoteMemoryInput, MemoryVisibility, MemoryKind } from '@dsh-platform/shared'
import { randomUUID } from 'node:crypto'
import { memoryRepository, contentHashOf } from '../repositories/memory-repository.js'
import { auditRepository } from '../repositories/audit-repository.js'
import { execute } from '../db.js'
import { isSecretLike, isSensitiveContent, inferKind } from '../memory-extraction.js'
import { buildMemoryProjection } from '../memory-projection.js'
import { config } from '../config.js'

export class MemoryService {
  /** 手工/内部创建(统一入口)。secret 拒绝;exact-duplicate 幂等。 */
  async remember(ctx: TenantContext, content: string, options?: {
    kind?: MemoryKind
    namespace?: string
    sourceType?: string
    sourceSessionId?: string
    sourceEventSeq?: number
    confidence?: number
    extractionMode?: string
    supersedesMemoryId?: string
  }): Promise<MemoryRecord> {
    const trimmed = content.trim()
    if (trimmed === '') throw new Error('content-required')
    if (trimmed.length > 2000) throw new Error('content-too-long')
    if (isSecretLike(trimmed)) throw new Error('secret-not-allowed')

    const namespace = options?.namespace ?? 'default'
    const kind: MemoryKind = options?.kind ?? inferKind(trimmed)
    const hash = contentHashOf(trimmed)
    const existing = await memoryRepository.findByContentHash(ctx.userId, hash, kind, namespace)
    if (existing) return existing

    const record = await memoryRepository.create({
      tenantId: ctx.tenantId,
      ownerUserId: ctx.userId,
      namespace,
      content: trimmed,
      kind,
      visibility: 'personal',
      sourceType: (options?.sourceType as MemoryRecord['sourceType']) ?? 'user_fact',
      sourceSessionId: options?.sourceSessionId ?? null,
      sourceEventSeq: options?.sourceEventSeq ?? null,
      confidence: options?.confidence ?? null,
      extractionMode: options?.extractionMode ?? 'manual',
      reviewStatus: 'approved',
    })

    if (options?.supersedesMemoryId !== undefined) {
      const old = await memoryRepository.findOwned(ctx, options.supersedesMemoryId)
      if (old) await memoryRepository.supersede(old.id, record.id)
    }

    await auditRepository.write({ action: 'memory.create', ctx, subject: `memory.create:${record.id}` })
    return record
  }

  async search(ctx: TenantContext, input: MemorySearchInput): Promise<MemorySearchResult> {
    return memoryRepository.search(ctx, input)
  }

  async forget(ctx: TenantContext, memoryId: string): Promise<boolean> {
    const deleted = await memoryRepository.delete(ctx, memoryId)
    if (deleted) {
      await auditRepository.write({ action: 'memory.delete', ctx, subject: `memory.delete:${memoryId}` })
    }
    return deleted
  }

  async promote(ctx: TenantContext, input: PromoteMemoryInput): Promise<{ ok: boolean; reason?: string }> {
    const record = await memoryRepository.findOwned(ctx, input.memoryId)
    if (!record) return { ok: false, reason: 'not-found' }
    if (record.visibility === input.targetVisibility) return { ok: false, reason: 'already-in-target-visibility' }
    if (input.targetVisibility === 'tenant_shared' && ctx.role === 'member') {
      return { ok: false, reason: 'promotion-requires-operator' }
    }

    await memoryRepository.updateVisibility(ctx, input.memoryId, input.targetVisibility)

    const promotionId = randomUUID()
    await execute(
      `INSERT INTO t_dsh_memory_promotions (id, memory_id, from_visibility, to_visibility, requested_by, reviewed_by, status, reason)
       VALUES (?, ?, ?, ?, ?, ?, 'approved', ?)`,
      [promotionId, input.memoryId, record.visibility, input.targetVisibility, ctx.userId, ctx.userId, input.reason ?? null],
    )
    await auditRepository.write({
      action: 'memory.promote', ctx,
      subject: `memory.promote:${input.memoryId}:${record.visibility}->${input.targetVisibility}`,
    })
    return { ok: true }
  }

  async get(ctx: TenantContext, memoryId: string): Promise<MemoryRecord | undefined> {
    return memoryRepository.findById(ctx, memoryId)
  }

  // --- Runtime(internal channel 已解析出 userId/tenantId) ---

  async runtimeSearch(userId: string, tenantId: string, query: string, kind: string | undefined, limit: number): Promise<Array<{
    id: string; kind: string; content: string; scope: string; namespace: string; updatedAt: string; score: number
  }>> {
    const bounded = Math.min(Math.max(1, limit), 20)
    return memoryRepository.searchForRuntime(userId, tenantId, query, kind, bounded, config.memory.teamRuntimeEnabled)
  }

  async runtimeGet(userId: string, tenantId: string, memoryId: string): Promise<{ id: string; kind: string; content: string; namespace: string; updatedAt: string } | null> {
    const owned = await memoryRepository.listProjectable(userId, tenantId)
    const m = owned.find((r) => r.id === memoryId)
    return m ? { id: m.id, kind: m.kind, content: m.content, namespace: m.namespace, updatedAt: m.updatedAt } : null
  }

  async runtimeRemember(userId: string, tenantId: string, content: string, options?: {
    kind?: MemoryKind; namespace?: string; sourceSessionId?: string; sourceEventSeq?: number; extractionMode?: string
  }): Promise<MemoryRecord> {
    const ctx: TenantContext = { tenantId, userId, role: 'member', requestId: '', platformSessionId: '', deviceId: '' }
    return this.remember(ctx, content, {
      kind: options?.kind, namespace: options?.namespace, sourceType: 'user_fact',
      sourceSessionId: options?.sourceSessionId, sourceEventSeq: options?.sourceEventSeq,
      extractionMode: options?.extractionMode ?? 'manual',
    })
  }

  async runtimeForget(userId: string, tenantId: string, memoryId: string): Promise<boolean> {
    const deleted = await memoryRepository.softDeleteByOwner(memoryId, userId, tenantId)
    if (deleted) {
      const ctx: TenantContext = { tenantId, userId, role: 'member', requestId: '', platformSessionId: '', deviceId: '' }
      await auditRepository.write({ action: 'memory.delete', ctx, subject: `memory.delete:${memoryId}` })
    }
    return deleted
  }

  async buildProjection(userId: string, tenantId: string): Promise<void> {
    await buildMemoryProjection(tenantId, userId)
  }

  /** 自动提取:仅显式 remember 语义 + 非 secret/敏感 → personal/private。 */
  async extractAndPersist(userId: string, tenantId: string, sourceSessionId: string, turn: number, memories: Array<{ content: string; kind: MemoryKind }>): Promise<number> {
    if (!config.memory.autoExtraction) return 0
    let count = 0
    for (const m of memories) {
      if (isSecretLike(m.content) || isSensitiveContent(m.content)) continue
      const ctx: TenantContext = { tenantId, userId, role: 'member', requestId: '', platformSessionId: '', deviceId: '' }
      const before = await memoryRepository.findByContentHash(userId, contentHashOf(m.content), m.kind, 'default')
      if (before) continue
      await this.remember(ctx, m.content, {
        kind: m.kind, sourceType: 'user_fact', sourceSessionId, sourceEventSeq: turn,
        extractionMode: 'explicit_user',
      })
      count += 1
    }
    if (count > 0) await buildMemoryProjection(tenantId, userId)
    return count
  }
}

export const memoryService = new MemoryService()