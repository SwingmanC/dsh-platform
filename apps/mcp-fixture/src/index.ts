/**
 * CMCC MCP Fixture Server —— 真实、本地、无副作用的 Streamable HTTP MCP server。
 *
 * 用途:Phase 06 端到端验证 DSH 官方 `@deepseek-ai/dsh-mcp-client`
 * → MCP protocol → fixture server → tool result。
 *
 * 工具:
 *   cmcc_echo(text) → "echo:<text>"
 *   cmcc_marker()   → "CMCC_MCP_FIXTURE_06"
 *
 * 安全:不提供 shell / 文件写 / 网络代理 / DB 变更。仅回显。
 *
 * 可选鉴权:设置 MCP_FIXTURE_TOKEN 时要求 `Authorization: Bearer <token>`,
 * 用于验证 Gateway→Runtime 的 secret 注入。
 */
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import * as z from 'zod'

export const FIXTURE_MARKER = 'CMCC_MCP_FIXTURE_06'

export function createFixtureServer(): McpServer {
  const server = new McpServer({ name: 'cmcc-mcp-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.registerTool('cmcc_echo', {
    description: 'Echo the provided text back. Read-only.',
    inputSchema: { text: z.string().describe('Text to echo') },
  }, async ({ text }: { text: string }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }))
  server.registerTool('cmcc_marker', {
    description: 'Return the Phase 06 unique marker. Read-only, no side effects.',
    inputSchema: {},
  }, async () => ({ content: [{ type: 'text', text: FIXTURE_MARKER }] }))
  return server
}

export interface FixtureHandle {
  url: string
  port: number
  close: () => Promise<void>
}

/** 启动 fixture(可指定 port;0 = 随机)。 */
export async function startFixture(port = 0): Promise<FixtureHandle> {
  const app = createMcpExpressApp()
  const transports: Record<string, StreamableHTTPServerTransport> = {}
  const expectedToken = process.env.MCP_FIXTURE_TOKEN ?? ''

  const requireAuth = (req: { headers: Record<string, unknown> }): boolean => {
    if (expectedToken === '') return true
    const header = req.headers['authorization']
    return typeof header === 'string' && header === `Bearer ${expectedToken}`
  }

  app.post('/mcp', async (req: any, res: any) => {
    if (!requireAuth(req)) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null })
      return
    }
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      let transport: StreamableHTTPServerTransport
      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId] as StreamableHTTPServerTransport
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sid: string) => { transports[sid] = transport },
        })
        const server = createFixtureServer()
        await server.connect(transport)
        await transport.handleRequest(req, res, req.body)
        return
      } else {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request' }, id: null })
        return
      }
      await transport.handleRequest(req, res, req.body)
    } catch {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null })
      }
    }
  })

  app.get('/mcp', (_req: any, res: any) => {
    res.status(405).set('Allow', 'POST').send('Method Not Allowed')
  })

  return new Promise<FixtureHandle>((resolve, reject) => {
    const listener = app.listen(port, '127.0.0.1', (error?: unknown) => {
      if (error) { reject(error); return }
      const address = listener.address()
      const actualPort = typeof address === 'object' && address !== null ? address.port : port
      resolve({
        url: `http://127.0.0.1:${actualPort}/mcp`,
        port: actualPort,
        close: () => new Promise<void>((res) => { listener.close(() => res()) }),
      })
    })
  })
}

/** 直接运行时启动(默认端口 9099)。 */
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly || process.env.MCP_FIXTURE_AUTOSTART === '1') {
  const port = Number(process.env.MCP_FIXTURE_PORT ?? '9099')
  startFixture(port).then((h) => {
    process.stderr.write(`[mcp-fixture] listening on ${h.url}\n`)
  }).catch((err: unknown) => {
    process.stderr.write(`[mcp-fixture] failed: ${String(err)}\n`)
    process.exit(1)
  })
}