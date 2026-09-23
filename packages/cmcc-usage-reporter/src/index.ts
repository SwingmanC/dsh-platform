/**
 * Runtime 侧只采集 DSH 持久事件中的权威 usage，并通过短期 Runtime Token 上报。
 * 不读取租户/用户参数、不访问平台数据库、不计算费用。
 */
import path from 'node:path'
import { UsageSpool } from './spool.js'
import type { UsagePayload } from './spool.js'

export const name = 'cmcc-usage-reporter'

interface SessionLike { id?: string }
interface SessionEventLike { type?: string; seq?: number; time?: number; data?: unknown }
interface PluginContext {
  on(event: string, listener: (session: SessionLike, event: SessionEventLike) => void): (() => void) | void
}

function finiteCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** assistant/message 是成功调用权威值；assistant/attempt 保留失败调用的实际消耗。 */
export function usageFromEvent(session: SessionLike, event: SessionEventLike): UsagePayload | null {
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return null
  if (typeof session.id !== 'string' || session.id === '' || !Number.isSafeInteger(event.seq)) return null
  const data = event.data as Record<string, unknown> | undefined
  const message = data?.message as Record<string, unknown> | undefined
  // DSH 的模型身份保存在 assistant/message.data.message.source(kind=model),
  // 而非 message 或 event.data 的顶层字段。
  const source = message?.source as Record<string, unknown> | undefined
  const usage = (data?.usage ?? message?.usage) as Record<string, unknown> | undefined
  if (!usage) return null
  const inputTokens = finiteCount(usage.inputTokens)
  const outputTokens = finiteCount(usage.outputTokens)
  const cacheReadTokens = finiteCount(usage.cacheReadTokens)
  const cacheWriteTokens = finiteCount(usage.cacheWriteTokens)
  const reasoningTokens = finiteCount(usage.reasoningTokens)
  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens === 0) return null
  const provider = (source?.kind === 'model' ? nonEmptyString(source.provider) : undefined)
    ?? nonEmptyString(data?.provider) ?? nonEmptyString(message?.provider) ?? 'unknown'
  const model = (source?.kind === 'model' ? nonEmptyString(source.model) : undefined)
    ?? nonEmptyString(data?.model) ?? nonEmptyString(message?.model) ?? 'unknown'
  return { sessionId: session.id, eventSeq: event.seq as number,
    occurredAt: new Date(typeof event.time === 'number' ? event.time : Date.now()).toISOString(),
    provider, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens }
}

export function apply(ctx: PluginContext): void {
  const url = process.env.PLATFORM_INTERNAL_URL ?? ''
  const token = process.env.PLATFORM_INTERNAL_TOKEN ?? ''
  if (url === '' || token === '') {
    process.stderr.write('[cmcc-usage-reporter] 内部上报通道未配置，用量将暂存本地\n')
  }
  const spool = new UsageSpool(path.join(process.env.DSH_HOME ?? process.cwd(), 'usage-spool'), url, token)
  spool.start()
  ctx.on('session/event', (session, event) => {
    const payload = usageFromEvent(session, event)
    if (payload) void spool.enqueue(payload).catch((error: unknown) => {
      process.stderr.write(`[cmcc-usage-reporter] 用量落盘失败，无法上报：${error instanceof Error ? error.message : 'unknown'}\n`)
    })
  })
}
