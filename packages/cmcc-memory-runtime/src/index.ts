/**
 * cmcc-memory-runtime —— CMCC 平台 Memory Runtime Adapter(Host-only dsh 插件)。
 *
 * - 读:每用户投影(ACL 预过滤 personal/private)→ memory tools + bounded recall。
 * - 写:经 Gateway internal mutation channel(ephemeral token)。
 * - 提取:session/event 的 turn/end(completed)→ 确定性显式提取 → 写回。
 *
 * 纪律:不发明 ctx.memory;不直连 DB;不持有浏览器 sid / launch token。
 * 契约:见 docs/implementation/REWORK-07-dsh-memory-contract.md。
 */
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createProjectionCache } from './projection-reader.js'
import { makeMemoryTools } from './tools.js'
import { registerRecallContext } from './recall.js'
import type { RecallStats } from './recall.js'
import { extractExplicitMemories } from './extraction.js'
import { textOf } from './recall.js'
import { internalExtract } from './internal-client.js'
import type { InternalChannel } from './internal-client.js'

export const name = 'cmcc-memory-runtime'
export const inject = ['tools', 'systemPrompt']

interface ToolDef {
  name: string; description: string; parameters: unknown
  output: { schema: unknown; render: (args: unknown, value: unknown) => unknown[] }
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown>
  timeoutMs?: number
}

interface SessionLike { id?: string }
interface SessionEventLike { type?: string; data?: unknown }

interface PluginContext {
  tools: { register(definition: ToolDef): () => void }
  systemPrompt: { context(entry: { name: string; order: number; text: (context: never) => string }): () => void }
  on(event: string, listener: (session: SessionLike, event: SessionEventLike) => void): (() => void) | void
  effect(body: () => (() => void) | void): void
}

async function readDesiredRevision(dir: string): Promise<string> {
  try {
    const raw = await readFile(path.join(dir, 'status.json'), 'utf8')
    const parsed = JSON.parse(raw) as { desiredRevision?: unknown }
    return typeof parsed.desiredRevision === 'string' ? parsed.desiredRevision : ''
  } catch {
    return ''
  }
}

async function writeAck(dir: string, stats: RecallStats): Promise<void> {
  const observedRevision = await readDesiredRevision(dir)
  const file = path.join(dir, 'ack.json')
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  const payload = {
    observedRevision,
    lastObservedAt: new Date().toISOString(),
    error: null,
    recallCount: stats.recallCount,
    lastRecallAt: stats.lastRecallAt,
    lastRecallIds: stats.lastRecallIds,
    lastRecallBytes: stats.lastRecallBytes,
  }
  try {
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
    await rename(tmp, file)
  } catch { /* ack 失败不影响 Runtime */ }
}

export function apply(ctx: PluginContext): void {
  const dir = process.env.PLATFORM_MEMORY_PROJECTION_DIR
  if (dir === undefined || dir === '') return

  const channel: InternalChannel = {
    url: process.env.PLATFORM_MEMORY_INTERNAL_URL ?? '',
    token: process.env.PLATFORM_MEMORY_INTERNAL_TOKEN ?? '',
  }
  const budget = {
    maxRecallItems: Number(process.env.PLATFORM_MEMORY_MAX_RECALL_ITEMS ?? '8'),
    maxRecallBytes: Number(process.env.PLATFORM_MEMORY_MAX_RECALL_BYTES ?? '4096'),
    maxItemBytes: Number(process.env.PLATFORM_MEMORY_MAX_ITEM_BYTES ?? '512'),
  }
  const stats: RecallStats = { recallCount: 0, lastRecallAt: null, lastRecallIds: [], lastRecallBytes: 0 }
  const cache = createProjectionCache(dir)

  // tools
  for (const tool of makeMemoryTools(cache, channel)) ctx.tools.register(tool)
  // bounded recall(systemPrompt.context,user-role)
  registerRecallContext(ctx, cache, stats, budget)

  // extraction:session/event → turn/end completed
  const sessionState = new Map<string, { turn: number; userTexts: string[] }>()
  const processed = new Set<string>()
  ctx.on('session/event', (session: SessionLike, event: SessionEventLike) => {
    try {
      const id = session?.id
      if (typeof id !== 'string' || id === '') return
      let st = sessionState.get(id)
      if (st === undefined) { st = { turn: -1, userTexts: [] }; sessionState.set(id, st) }
      if (event?.type === 'turn/start') {
        const turn = (event.data as { turn?: unknown } | undefined)?.turn
        if (typeof turn === 'number') st.turn = turn
        st.userTexts = []
      } else if (event?.type === 'user/message') {
        const t = textOf(event.data)
        if (t !== '') st.userTexts.push(t)
      } else if (event?.type === 'turn/end') {
        const reasonKind = (event.data as { reason?: { kind?: unknown } } | undefined)?.reason?.kind
        if (reasonKind === 'completed' && channel.url !== '' && channel.token !== '') {
          const key = `${id}:${st.turn}`
          if (!processed.has(key)) {
            processed.add(key)
            const memories = st.userTexts.flatMap((t) => extractExplicitMemories(t))
            if (memories.length > 0) void internalExtract(channel, id, st.turn, memories)
          }
        }
        st.userTexts = []
      }
    } catch { /* 提取失败不影响 Runtime */ }
  })

  // ack evidence
  void writeAck(dir, stats)
  const timer = setInterval(() => { void writeAck(dir, stats) }, 3000)
  if (typeof timer.unref === 'function') timer.unref()
  // dispose 时关闭缓存(watch)+ 定时器。
  ctx.effect(() => () => { clearInterval(timer); cache.close() })
}