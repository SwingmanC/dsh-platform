/**
 * cmcc-mcp-probe —— Phase 06 E2E 专用探测插件(仅测试组合使用,不在生产 profile)。
 *
 * 等待官方 dsh-mcp-client 注册 `mcp__<server>__<tool>` 后,经官方
 * `ctx.tools.execute(...)` 真实执行一次工具调用,把结果写入
 * `PLATFORM_MCP_PROBE_OUT`,证明:
 *   DSH ToolRuntime → dsh-mcp-client → MCP protocol → fixture server → result
 */
import { writeFile } from 'node:fs/promises'

export const name = 'cmcc-mcp-probe'
export const inject = ['tools']

interface PluginContext {
  tools: {
    schemas(scope?: unknown): Array<{ name?: unknown }>
    execute(input: { callId: string; name: string; arguments: unknown; signal: AbortSignal }): Promise<unknown>
  }
}

export function apply(ctx: PluginContext): void {
  const out = process.env.PLATFORM_MCP_PROBE_OUT
  const toolName = process.env.PLATFORM_MCP_PROBE_TOOL ?? 'mcp__fixture__cmcc_marker'
  if (out === undefined || out === '') return

  let attempts = 0
  const timer = setInterval(() => {
    attempts += 1
    void (async () => {
      try {
        const names = ctx.tools.schemas().map((s) => (typeof s.name === 'string' ? s.name : ''))
        if (names.includes(toolName)) {
          clearInterval(timer)
          const result = await ctx.tools.execute({
            callId: `probe-${Date.now()}`, name: toolName, arguments: {}, signal: new AbortController().signal,
          })
          await writeFile(out, JSON.stringify({ ok: true, toolName, result }, null, 2), 'utf8')
          return
        }
      } catch (err) {
        clearInterval(timer)
        await writeFile(out, JSON.stringify({ ok: false, toolName, error: String(err) }, null, 2), 'utf8')
        return
      }
      if (attempts > 60) clearInterval(timer)
    })()
  }, 500)
  timer.unref()
}
