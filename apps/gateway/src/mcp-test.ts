/**
 * MCP 连接测试探针 + 工具目录提取(Gateway 侧一次性短连,任务 02 / MCP-V1.1)。
 *
 * 设计:
 * - 仅 streamable-http;stdio 的进程拉起只归 Runtime 内官方 `@deepseek-ai/dsh-mcp-client`,
 *   网关侧绝不 spawn 任意进程(arbitrary process execution 载体)。
 * - 测试与持久化/审批/授权完全分离:只读 `initialize` + `tools/list`,随后立即关闭。
 * - 超时硬上限;错误消息经 secret 脱敏,不返回 stack/内部细节。
 * - 失败隔离:探针失败不产生任何投影/授权副作用。
 *
 * MCP-V1.1:工具目录(toToolCatalog)提取 name/description/inputSchema,
 * 并强制 数量 ≤200 / 单 schema ≤32KB / 快照总量 ≤256KB 安全边界。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export interface McpProbeOptions {
  url: string
  /** 需要鉴权时仅注入 Authorization;绝不接受任意自定义 header(防 header 注入面)。 */
  headers?: Record<string, string>
  timeoutMs: number
}

export interface McpProbeTool {
  name: string
  description: string | null
  /** MCP-V1.1:JSON Schema 原样透传(untrusted data,仅存储/展示)。 */
  inputSchema: Record<string, unknown>
}

export type McpProbeResult =
  | { ok: true; serverInfo: Record<string, unknown> | null; toolCount: number; tools: McpProbeTool[]; durationMs: number }
  | {
      ok: false
      code: 'test-timeout' | 'probe-failed' | 'too-many-tools' | 'tool-schema-too-large' | 'snapshot-too-large' | 'invalid-tools-response'
      message: string
      durationMs: number
    }

/** MCP-V1.1 安全边界:工具数量 / 单 schema / 快照总量。 */
export const MAX_DISCOVERED_TOOLS = 200
export const MAX_TOOL_SCHEMA_CHARS = 32 * 1024
export const MAX_SNAPSHOT_CHARS = 256 * 1024

/** MCP-V1.1 探针/目录错误(受控码;区别于网络类失败,不参与通用映射)。 */
export class McpTestError extends Error {
  constructor(readonly code: 'too-many-tools' | 'tool-schema-too-large' | 'snapshot-too-large' | 'invalid-tools-response') {
    super(code)
    this.name = 'McpTestError'
  }
}

/** 将错误消息中出现的 secret 值替换为 `******`,并截断长度(防日志/响应泄漏)。 */
export function redactSecrets(message: string, secrets: Array<string | null | undefined>, maxLen = 300): string {
  let out = typeof message === 'string' ? message : String(message)
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 4) {
      out = out.split(s).join('******')
    }
  }
  return out.length > maxLen ? `${out.slice(0, maxLen)}…` : out
}

/**
 * listTools 结果 → 工具目录(受控):
 * - 仅保留 name/description/inputSchema(inputSchema 为外部数据,原样透传仅存储/展示);
 * - 数量 > MAX_DISCOVERED_TOOLS → too-many-tools;
 * - 单 tool schema 序列化 > 32KB → tool-schema-too-large;
 * - 目录序列化总量 > 256KB → snapshot-too-large。
 */
export function toToolCatalog(rawTools: unknown[]): McpProbeTool[] {
  if (rawTools.length > MAX_DISCOVERED_TOOLS) throw new McpTestError('too-many-tools')
  const tools: McpProbeTool[] = []
  let total = 2 // '[]'
  for (const raw of rawTools) {
    const t = raw as { name?: unknown; description?: unknown; inputSchema?: unknown }
    if (typeof t?.name !== 'string' || t.name === '') throw new McpTestError('invalid-tools-response')
    const description = typeof t.description === 'string' ? t.description : null
    const schema = t.inputSchema
    const schemaJson = schema === undefined || schema === null ? '{}' : JSON.stringify(schema)
    if (schemaJson.length > MAX_TOOL_SCHEMA_CHARS) throw new McpTestError('tool-schema-too-large')
    const tool: McpProbeTool = {
      name: t.name,
      description,
      inputSchema: schema === undefined || schema === null ? {} : (schema as Record<string, unknown>),
    }
    total += JSON.stringify(tool).length + 1
    if (total > MAX_SNAPSHOT_CHARS) throw new McpTestError('snapshot-too-large')
    tools.push(tool)
  }
  return tools
}

/** 一次性连接测试:initialize → tools/list → close。绝不调用任何工具。 */
export async function probeMcpServer(opts: McpProbeOptions): Promise<McpProbeResult> {
  const started = Date.now()
  const client = new Client({ name: 'dsh-platform-connector-test', version: '1.0.0' })
  let timedOut = false
  let timer: NodeJS.Timeout | undefined
  // 结构性硬超时:无论 SDK 内部状态如何,本 Promise 必须在 deadline 结算,
  // 绝不让 HTTP 请求悬挂。超时路径尽力 close() 释放底层连接(不阻塞返回)。
  const deadline = new Promise<McpProbeResult>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      resolve({ ok: false, code: 'test-timeout', message: `probe did not settle within ${opts.timeoutMs}ms`, durationMs: Date.now() - started })
      void client.close().catch(() => undefined)
    }, Math.max(1_000, opts.timeoutMs))
  })
  const attempt = (async (): Promise<McpProbeResult> => {
    try {
      const transport = new StreamableHTTPClientTransport(new URL(opts.url), {
        requestInit: opts.headers === undefined ? undefined : { headers: { ...opts.headers } },
      })
      await client.connect(transport)
      const listing = await client.listTools()
      const tools = toToolCatalog(listing.tools ?? [])
      let serverInfo: Record<string, unknown> | null = null
      try {
        const v = (client as unknown as { getServerVersion?: () => unknown }).getServerVersion?.()
        serverInfo = v === undefined || v === null ? null : (v as Record<string, unknown>)
      } catch { /* serverInfo 仅为展示信息,失败不阻断 */ }
      return { ok: true, serverInfo, toolCount: tools.length, tools, durationMs: Date.now() - started }
    } catch (err) {
      if (err instanceof McpTestError) throw err // 受控目录错误原样上抛(服务层映射为结构化响应)
      const raw = err instanceof Error ? err.message : String(err)
      // 错误消息可能回显请求 header(fetch 层错误),统一按 header 值脱敏。
      return {
        ok: false,
        code: timedOut ? 'test-timeout' : 'probe-failed',
        message: redactSecrets(raw, Object.values(opts.headers ?? {})),
        durationMs: Date.now() - started,
      }
    }
  })()
  // attempt 若在超时后仍悬挂,attach catch 防 unhandledRejection;进程内连接由 close() 兜底释放。
  void deadline.then(() => { attempt.then(() => undefined, () => undefined) })
  try {
    return await Promise.race([attempt, deadline])
  } finally {
    clearTimeout(timer)
    void client.close().catch(() => undefined)
  }
}
