/**
 * Runtime 侧只采集 DSH 持久事件中的权威 usage，并通过短期 Runtime Token 上报。
 * 不读取租户/用户参数、不访问平台数据库、不计算费用。
 */
export const name = 'cmcc-usage-reporter'

interface SessionLike { id?: string }
interface SessionEventLike { type?: string; seq?: number; time?: number; data?: unknown }
interface UsagePayload {
  sessionId: string; eventSeq: number; occurredAt: string; provider: string; model: string
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number
}
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

async function report(url: string, token: string, payload: UsagePayload): Promise<void> {
  try {
    await fetch(`${url}/internal/usage/events`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-runtime-token': token,
    }, body: JSON.stringify(payload) })
  } catch { /* 统计失败不能影响 Agent 主链路；持久补偿留给后续 telemetry spool。 */ }
}

export function apply(ctx: PluginContext): void {
  const url = process.env.PLATFORM_INTERNAL_URL ?? ''
  const token = process.env.PLATFORM_INTERNAL_TOKEN ?? ''
  if (url === '' || token === '') return
  ctx.on('session/event', (session, event) => {
    const payload = usageFromEvent(session, event)
    if (payload) void report(url, token, payload)
  })
}
