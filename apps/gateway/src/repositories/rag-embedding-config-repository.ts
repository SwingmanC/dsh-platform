/**
 * K-T3:Embedding Provider 配置仓储(每租户一套 active config;tenant_id 唯一约束)。
 * envelope 只进不出;GET 视图不含 envelope/明文。
 */
import { randomUUID } from 'node:crypto'
import { execute, queryOne } from '../db.js'

interface EmbeddingConfigRow {
  id: string
  tenantId: string
  provider: string
  baseUrl: string
  model: string
  dims: number
  keyHint: string
  lastTestAt: string | null
  lastError: string | null
}

const COLS = `id, tenant_id AS tenantId, provider, base_url AS baseUrl, model, dims,
  key_hint AS keyHint, last_test_at AS lastTestAt, last_error AS lastError`

export interface EmbeddingConfigUpsert {
  provider: string
  baseUrl: string
  model: string
  dims: number
  envelope: Buffer
  keyHint: string
}

export class RagEmbeddingConfigRepository {
  async getByTenant(tenantId: string): Promise<EmbeddingConfigRow | undefined> {
    return queryOne<EmbeddingConfigRow>(
      `SELECT ${COLS} FROM t_dsh_rag_embedding_config WHERE tenant_id = ?`, [tenantId])
  }

  async getEnvelope(tenantId: string): Promise<Buffer | null> {
    const row = await queryOne<{ envelope: Buffer | string }>(
      `SELECT api_key_envelope AS envelope FROM t_dsh_rag_embedding_config WHERE tenant_id = ?`, [tenantId])
    if (!row) return null
    return typeof row.envelope === 'string' ? Buffer.from(row.envelope, 'utf8') : row.envelope
  }

  /** 每租户单行:ON DUPLICATE KEY UPDATE(全部字段覆盖;api_key 保留语义由调用方决定 envelope 内容)。 */
  async upsert(tenantId: string, data: EmbeddingConfigUpsert): Promise<void> {
    const id = randomUUID()
    await execute(
      `INSERT INTO t_dsh_rag_embedding_config
         (id, tenant_id, provider, base_url, model, dims, api_key_envelope, key_hint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         provider = VALUES(provider), base_url = VALUES(base_url), model = VALUES(model),
         dims = VALUES(dims), api_key_envelope = VALUES(api_key_envelope), key_hint = VALUES(key_hint)`,
      [id, tenantId, data.provider, data.baseUrl, data.model, data.dims, data.envelope, data.keyHint])
  }

  async markTest(tenantId: string, ok: boolean, error?: string): Promise<void> {
    if (ok) {
      await execute(`UPDATE t_dsh_rag_embedding_config SET last_test_at = UTC_TIMESTAMP(3), last_error = NULL WHERE tenant_id = ?`, [tenantId])
    } else if (error !== undefined) {
      await execute(`UPDATE t_dsh_rag_embedding_config SET last_test_at = UTC_TIMESTAMP(3), last_error = ? WHERE tenant_id = ?`, [error.slice(0, 255), tenantId])
    }
  }
}

export const ragEmbeddingConfigRepository = new RagEmbeddingConfigRepository()
export type { EmbeddingConfigRow }
