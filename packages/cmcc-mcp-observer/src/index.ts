/**
 * cmcc-mcp-observer —— MCP Runtime 观测插件(Host-only)。
 *
 * 读取官方 `ctx.tools` 中由 `@deepseek-ai/dsh-mcp-client` 注册的
 * `mcp__<serverName>__<rawName>` 工具,把真实观测 evidence 写入
 * `PLATFORM_MCP_PROJECTION_DIR/ack.json`。
 *
 * 纪律:
 * - 不实现 MCP 协议、不连接 server(那是官方 dsh-mcp-client 的职责)。
 * - 只读 ctx.tools 可观察面 + 投影目录,不含 secret。
 * - Gateway 据 desired(projection)与 observed(ack)判定 CONNECTED/SYNCING/RESTART_REQUIRED。
 */
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const name = 'cmcc-mcp-observer'
export const inject = ['tools']

interface ToolSchemaLike { name?: unknown }

interface PluginContext {
  tools: { schemas(scope?: unknown): ToolSchemaLike[] }
  on?(event: string, listener: () => void): (() => void) | void
  effect?(fn: () => (() => void) | void): void
}

interface ObservedServer {
  serverName: string
  toolCount: number
  tools: string[]
}

const MCP_TOOL_RE = /^mcp__([A-Za-z0-9_-]{1,32})__(.+)$/

/** 从工具 schema 列表提取 mcp__ 工具并按 serverName 分组。 */
export function groupMcpTools(schemas: ToolSchemaLike[]): ObservedServer[] {
  const byServer = new Map<string, string[]>()
  for (const schema of schemas) {
    const toolName = typeof schema.name === 'string' ? schema.name : ''
    const match = MCP_TOOL_RE.exec(toolName)
    if (!match) continue
    const serverName = match[1] as string
    const list = byServer.get(serverName) ?? []
    list.push(toolName)
    byServer.set(serverName, list)
  }
  return [...byServer.entries()]
    .map(([serverName, tools]) => ({ serverName, toolCount: tools.length, tools: tools.sort() }))
    .sort((a, b) => a.serverName.localeCompare(b.serverName))
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

async function writeAck(dir: string, servers: ObservedServer[]): Promise<void> {
  const observedRevision = await readDesiredRevision(dir)
  const file = path.join(dir, 'ack.json')
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  const payload = {
    observedRevision,
    lastObservedAt: new Date().toISOString(),
    error: null,
    servers,
    toolCount: servers.reduce((sum, s) => sum + s.toolCount, 0),
  }
  try {
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
    await rename(tmp, file)
  } catch {
    // ack 写入失败不影响 Runtime。
  }
}

export function apply(ctx: PluginContext): void {
  const dir = process.env.PLATFORM_MCP_PROJECTION_DIR
  if (dir === undefined || dir === '') return

  const observe = (): void => {
    try {
      const servers = groupMcpTools(ctx.tools.schemas())
      void writeAck(dir, servers)
    } catch {
      // 观测失败不 crash Runtime。
    }
  }

  observe()
  try {
    ctx.on?.('tools/change', observe)
  } catch {
    // 事件订阅不可用时忽略(初始 observe 已写)。
  }
  // 官方 mcp-client 的 apply 是 async:初次连接完成晚于本插件;周期性重观测兜底。
  const timer = setInterval(observe, 3000)
  if (typeof timer.unref === 'function') timer.unref()
}