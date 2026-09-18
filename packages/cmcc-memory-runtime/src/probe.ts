/**
 * cmcc-memory-probe —— Phase 07 E2E 专用探测插件(仅测试组合使用,不在生产 profile)。
 *
 * 经官方 seams 验证完整闭环:
 *   1. memory_remember tool → internal channel → Gateway DB
 *   2. 合成 completed-turn session/event → 自动提取 → Gateway DB
 *   3. memory_search tool → 投影可见
 *   4. systemPrompt.assemble(fake agent) → bounded recall 注入块
 *   5. memory_forget tool → 投影消失
 */
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'cmcc-memory-probe'
export const inject = ['tools', 'systemPrompt', 'sessions']

interface SessionLike {
  id: string
  append(type: string, data: unknown, opts?: unknown): unknown
}

interface ProbeContext {
  tools: {
    execute(input: { callId: string; name: string; arguments: unknown; signal: AbortSignal }): Promise<unknown>
  }
  systemPrompt: {
    assemble(context?: unknown): Promise<{ contexts: Array<{ name: string; text: string }> }>
  }
  sessions: {
    create(id?: string, options?: unknown): SessionLike
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function loadCreateUserMessage(): Promise<(input: { content: unknown; source: unknown }) => unknown> {
  const bin = process.env.E2E_DSH_BIN ?? ''
  if (bin === '') return (input) => input
  const nodeModules = path.resolve(path.dirname(bin), '..', '..', '..')
  const llmEntry = path.join(nodeModules, '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')
  const mod = await import(pathToFileURL(llmEntry).href) as { createUserMessage?: (input: { content: unknown; source: unknown }) => unknown }
  return mod.createUserMessage ?? ((input) => input)
}

async function execute(ctx: ProbeContext, name: string, args: unknown): Promise<unknown> {
  try {
    return await ctx.tools.execute({ callId: `${name}-${Date.now()}`, name, arguments: args, signal: new AbortController().signal })
  } catch (err) {
    return { error: String(err) }
  }
}

export function apply(ctx: ProbeContext): void {
  const out = process.env.E2E_MEMORY_PROBE_OUT
  if (out === undefined || out === '') return
  const marker = process.env.E2E_MEMORY_PROBE_MARKER ?? 'CMCC_MEMORY_07'
  const sessionId = process.env.E2E_MEMORY_PROBE_SESSION ?? 'e2e-session-1'
  const startDelay = Number(process.env.E2E_MEMORY_PROBE_DELAY ?? '6000')
  const doForget = process.env.E2E_MEMORY_PROBE_FORGET === '1'

  const run = async (): Promise<void> => {
    const log: Record<string, unknown> = {}
    await delay(startDelay)

    // 1. explicit remember via tool (personal/private)
    log.remember = await execute(ctx, 'memory_remember', { content: `project code is ${marker}`, kind: 'fact' })
    await delay(1500)

    // 2. real completed turn (S1) → automatic extraction
    try {
      const createUserMessage = await loadCreateUserMessage()
      const session = ctx.sessions.create()
      const userMessage = createUserMessage({ content: [{ type: 'text', text: `请记住:我的项目代号是 ${marker}` }], source: { kind: 'user' } })
      session.append('turn/start', { turn: 1 })
      session.append('user/message', userMessage, { surfaceOp: 'append' })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      log.extractionSessionId = session.id
    } catch (err) {
      log.extractionError = String(err)
    }
    await delay(2500)

    // 3. search via tool
    log.search = await execute(ctx, 'memory_search', { query: marker })
    const foreign = process.env.E2E_MEMORY_PROBE_FOREIGN ?? ''
    if (foreign !== '') log.foreignSearch = await execute(ctx, 'memory_search', { query: foreign })

    // 3b. secret exclusion: model-facing remember must reject secret-like content
    log.secretRemember = await execute(ctx, 'memory_remember', { content: 'password: CMCC_SECRETLIKE_MEMORY_07', kind: 'other' })

    // 3c. aborted turn must NOT extract
    const abortedMarker = `${marker}_ABORTED`
    try {
      const createUserMessage = await loadCreateUserMessage()
      const session2 = ctx.sessions.create()
      session2.append('turn/start', { turn: 1 })
      session2.append('user/message', createUserMessage({ content: [{ type: 'text', text: `请记住:中止标记 ${abortedMarker}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      session2.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: 'user-cancel' } })
    } catch (err) {
      log.abortError = String(err)
    }
    await delay(1500)
    log.abortedSearch = await execute(ctx, 'memory_search', { query: abortedMarker })

    // 4. bounded recall injection via official systemPrompt assembly (global)
    try {
      const assembly = await ctx.systemPrompt.assemble()
      log.recallContexts = assembly.contexts.filter((c) => c.name === 'cmcc-memory-recall').map((c) => c.text)
    } catch (err) {
      log.recallError = String(err)
      log.recallStack = err instanceof Error ? err.stack : undefined
    }

    // 5. optional forget → search again
    if (doForget) {
      const search = log.search as { results?: Array<{ memoryId?: string }> } | undefined
      const firstId = search?.results?.[0]?.memoryId
      if (typeof firstId === 'string') {
        log.forget = await execute(ctx, 'memory_forget', { memoryId: firstId })
        await delay(1500)
        log.afterForget = await execute(ctx, 'memory_search', { query: marker })
      }
    }

    await writeFile(out, JSON.stringify(log, null, 2), 'utf8').catch(() => undefined)
  }

  void run()
}