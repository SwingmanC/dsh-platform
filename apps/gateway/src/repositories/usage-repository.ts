import { pool, queryMany, queryOne } from '../db.js'

export interface UsageEventInput {
  eventKey: string; tenantId: string; userId: string; sessionId: string; eventSeq: number
  provider: string; model: string; inputTokens: number; outputTokens: number
  cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; occurredAt: Date
}

export interface UsageSummary {
  totals: { requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number }
  daily: Array<{ day: string; requests: number; inputTokens: number; outputTokens: number }>
  users: Array<{ userId: string; displayName: string; requests: number; inputTokens: number; outputTokens: number }>
  models: Array<{ provider: string; model: string; requests: number; inputTokens: number; outputTokens: number }>
}

const columns = `COUNT(*) AS requests,
  COALESCE(SUM(input_tokens), 0) AS inputTokens,
  COALESCE(SUM(output_tokens), 0) AS outputTokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
  COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
  COALESCE(SUM(reasoning_tokens), 0) AS reasoningTokens`

function numbers<T extends Record<string, unknown>>(row: T): T {
  for (const key of ['requests', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    if (key in row) row[key as keyof T] = Number(row[key]) as T[keyof T]
  }
  return row
}

export class UsageRepository {
  async record(input: UsageEventInput): Promise<boolean> {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const [result] = await conn.execute(
        `INSERT IGNORE INTO t_dsh_usage_events
         (event_key, tenant_id, user_id, session_id, event_seq, provider, model,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.eventKey, input.tenantId, input.userId, input.sessionId, input.eventSeq,
          input.provider, input.model, input.inputTokens, input.outputTokens,
          input.cacheReadTokens, input.cacheWriteTokens, input.reasoningTokens, input.occurredAt],
      )
      const inserted = (result as { affectedRows: number }).affectedRows === 1
      if (inserted) {
        await conn.execute(
          `INSERT INTO t_dsh_usage_counters (tenant_id, day, tokens_in, tokens_out, requests)
           VALUES (?, DATE(?), ?, ?, 1)
           ON DUPLICATE KEY UPDATE tokens_in=tokens_in+VALUES(tokens_in),
             tokens_out=tokens_out+VALUES(tokens_out), requests=requests+1`,
          [input.tenantId, input.occurredAt, input.inputTokens + input.cacheReadTokens + input.cacheWriteTokens, input.outputTokens],
        )
      }
      await conn.commit()
      return inserted
    } catch (error) {
      await conn.rollback()
      throw error
    } finally { conn.release() }
  }

  async summary(tenantId: string, days: number): Promise<UsageSummary> {
    const since = new Date(Date.now() - (days - 1) * 86_400_000)
    since.setUTCHours(0, 0, 0, 0)
    const totals = numbers((await queryOne<Record<string, unknown>>(
      `SELECT ${columns} FROM t_dsh_usage_events WHERE tenant_id=? AND occurred_at>=?`, [tenantId, since],
    )) ?? {})
    const daily = (await queryMany<Record<string, unknown>>(
      `SELECT DATE_FORMAT(occurred_at, '%Y-%m-%d') AS day, COUNT(*) AS requests,
       SUM(input_tokens+cache_read_tokens+cache_write_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens
       FROM t_dsh_usage_events WHERE tenant_id=? AND occurred_at>=? GROUP BY day ORDER BY day`, [tenantId, since],
    )).map(numbers) as unknown as UsageSummary['daily']
    const users = (await queryMany<Record<string, unknown>>(
      `SELECT e.user_id AS userId, u.display_name AS displayName, COUNT(*) AS requests,
       SUM(e.input_tokens+e.cache_read_tokens+e.cache_write_tokens) AS inputTokens, SUM(e.output_tokens) AS outputTokens
       FROM t_dsh_usage_events e JOIN t_dsh_users u ON u.id=e.user_id
       WHERE e.tenant_id=? AND e.occurred_at>=? GROUP BY e.user_id,u.display_name ORDER BY inputTokens+outputTokens DESC LIMIT 100`, [tenantId, since],
    )).map(numbers) as unknown as UsageSummary['users']
    const models = (await queryMany<Record<string, unknown>>(
      `SELECT provider,model,COUNT(*) AS requests,
       SUM(input_tokens+cache_read_tokens+cache_write_tokens) AS inputTokens,SUM(output_tokens) AS outputTokens
       FROM t_dsh_usage_events WHERE tenant_id=? AND occurred_at>=?
       GROUP BY provider,model ORDER BY inputTokens+outputTokens DESC LIMIT 100`, [tenantId, since],
    )).map(numbers) as unknown as UsageSummary['models']
    return { totals: {
      requests: Number(totals.requests ?? 0), inputTokens: Number(totals.inputTokens ?? 0), outputTokens: Number(totals.outputTokens ?? 0),
      cacheReadTokens: Number(totals.cacheReadTokens ?? 0), cacheWriteTokens: Number(totals.cacheWriteTokens ?? 0), reasoningTokens: Number(totals.reasoningTokens ?? 0),
    }, daily, users, models }
  }
}

export const usageRepository = new UsageRepository()
