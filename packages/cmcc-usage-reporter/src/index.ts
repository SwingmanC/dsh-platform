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
function validUsage(usage: Record<string, unknown> | undefined): boolean {
  if (usage === undefined) return false
  if (finiteCount(usage.inputTokens) !== usage.inputTokens || finiteCount(usage.outputTokens) !== usage.outputTokens) return false
  for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    if (usage[key] !== undefined && finiteCount(usage[key]) !== usage[key]) return false
  }
  return true
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

interface ModelRoute { provider: string; model: string }
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}
function route(value: unknown): ModelRoute | undefined {
  const data = record(value)
  const provider = nonEmptyString(data?.provider)
  const model = nonEmptyString(data?.model)
  return provider && model ? { provider, model } : undefined
}
function lastStreamUsage(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined
  for (let index = value.length - 1; index >= 0; index--) {
    const entry = record(value[index])
    const chunk = record(entry?.chunk)
    if (entry?.type === 'chunk' && chunk?.type === 'usage') return record(chunk.usage)
  }
  return undefined
}
function location(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** 每条持久 assistant 结算事件对应一次模型尝试；缺少权威 usage 时只计次数，不估算 token。 */
export function usageFromEvent(session: SessionLike, event: SessionEventLike, currentRoute?: ModelRoute): UsagePayload | null {
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return null
  if (typeof session.id !== 'string' || session.id === '' || !Number.isSafeInteger(event.seq)) return null
  const data = record(event.data)
  const message = record(data?.message)
  // DSH 的模型身份保存在 assistant/message.data.message.source(kind=model),
  // 而非 message 或 event.data 的顶层字段。
  const source = record(message?.source)
  const candidate = record(data?.usage) ?? lastStreamUsage(data?.stream) ?? record(message?.usage)
  const usage = validUsage(candidate) ? candidate : undefined
  const inputTokens = finiteCount(usage?.inputTokens)
  const outputTokens = finiteCount(usage?.outputTokens)
  const cacheReadTokens = finiteCount(usage?.cacheReadTokens)
  const cacheWriteTokens = finiteCount(usage?.cacheWriteTokens)
  const reasoningTokens = finiteCount(usage?.reasoningTokens)
  const selectedRoute = (source?.kind === 'model' ? route(source) : undefined)
    ?? route(data) ?? currentRoute ?? route(message)
  const provider = selectedRoute?.provider ?? 'unknown'
  const model = selectedRoute?.model ?? 'unknown'
  return { sessionId: session.id, eventSeq: event.seq as number,
    occurredAt: new Date(typeof event.time === 'number' ? event.time : Date.now()).toISOString(),
    provider, model, eventType: event.type === 'assistant/message' ? 'message' : 'attempt',
    turn: location(data?.turn), step: location(data?.step), usageKnown: usage !== undefined,
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens }
}

export class UsageCollector {
  private readonly routes = new Map<string, ModelRoute>()
  collect(session: SessionLike, event: SessionEventLike): UsagePayload | null {
    if (!session.id) return null
    const data = record(event.data)
    if (event.type === 'request/context' || event.type === 'request/header') {
      const selectedRoute = event.type === 'request/context' ? route(data) : route(record(data?.header)?.config)
      if (selectedRoute) {
        this.routes.delete(session.id)
        this.routes.set(session.id, selectedRoute)
        if (this.routes.size > 1_000) this.routes.delete(this.routes.keys().next().value as string)
      }
      return null
    }
    return usageFromEvent(session, event, this.routes.get(session.id))
  }
}

export function apply(ctx: PluginContext): void {
  const url = process.env.PLATFORM_INTERNAL_URL ?? ''
  const token = process.env.PLATFORM_INTERNAL_TOKEN ?? ''
  if (url === '' || token === '') {
    process.stderr.write('[cmcc-usage-reporter] 内部上报通道未配置，用量将暂存本地\n')
  }
  const spool = new UsageSpool(path.join(process.env.DSH_HOME ?? process.cwd(), 'usage-spool'), url, token)
  const collector = new UsageCollector()
  spool.start()
  ctx.on('session/event', (session, event) => {
    const payload = collector.collect(session, event)
    if (payload) void spool.enqueue(payload).catch((error: unknown) => {
      process.stderr.write(`[cmcc-usage-reporter] 用量落盘失败，无法上报：${error instanceof Error ? error.message : 'unknown'}\n`)
    })
  })
}
