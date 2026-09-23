import { cp, copyFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import type { McpPatchEntry } from './mcp-projection.js'

/**
 * 平台插件包清单(03/04 canary composition)。每个包声明 `dsh.client`(client bundle)
 * 或纯 Host 插件;Host 半区经 `main` 解析,client 半区经 `exports["./client"]`。
 *
 * 06 变更:基础平台插件保持不变;MCP server rows 按用户 authorized connector
 * 动态追加(每 connector 一个官方 `@deepseek-ai/dsh-mcp-client` instance)。
 * 旧 modal UI 包(skill-plaza / knowledge-base / connector)继续排除。
 */
const PLATFORM_PACKAGES = [
  { name: '@dsh-platform/dsh-bridge', src: 'packages/dsh-bridge' },
  { name: '@dsh-platform/cmcc-platform-ui', src: 'packages/cmcc-platform-ui' },
  { name: '@dsh-platform/cmcc-skill-provider', src: 'packages/cmcc-skill-provider' },
  // Knowledge Runtime:Host-only;注册 knowledge_search / knowledge_read 工具。
  { name: '@dsh-platform/cmcc-knowledge-runtime', src: 'packages/cmcc-knowledge-runtime' },
  // MCP Runtime Observer:Host-only;把 ctx.tools 中 mcp__* 观测写入 ack.json。
  { name: '@dsh-platform/cmcc-mcp-observer', src: 'packages/cmcc-mcp-observer' },
  // Memory Runtime:Host-only;memory tools + bounded recall + explicit extraction。
  { name: '@dsh-platform/cmcc-memory-runtime', src: 'packages/cmcc-memory-runtime' },
  // Workspace Bootstrap:Host-only;经官方 workspaceRegistry.create 注册默认工作区。
  { name: '@dsh-platform/cmcc-workspace-bootstrap', src: 'packages/cmcc-workspace-bootstrap' },
] as const

/** YAML 双引号字符串转义(serverName/url 均为已校验的受限字符集)。 */
function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * 渲染一个 MCP plugin row。Authorization header 以 `!!js` 表达式引用 child env,
 * 不写入 secret value。
 */
export function renderMcpEntry(entry: McpPatchEntry): string {
  const c = entry.config as {
    serverName: string; transport: string; url: string
    headers: Record<string, string>; toolCallTimeoutMs: number; failOnStartupError: boolean
  }
  const lines = [
    `    - id: ${yamlString(entry.id)}`,
    `      name: ${yamlString(entry.name)}`,
    '      config:',
    `        serverName: ${yamlString(c.serverName)}`,
    `        transport: ${c.transport}`,
    `        url: ${yamlString(c.url)}`,
    '        headers:',
  ]
  const headerKeys = Object.keys(c.headers)
  if (headerKeys.length === 0) {
    lines[lines.length - 1] = '        headers: {}'
  } else {
    for (const key of headerKeys) {
      const raw = c.headers[key] as string
      // 形如 "Bearer ${process.env.VAR}" → 转为 !!js 模板表达式。
      const match = /^Bearer \$\{process\.env\.([A-Za-z0-9_]+)\}$/.exec(raw)
      if (match) {
        // 单引号包裹模板表达式:避免 YAML 把 ${...} 解析成 flow mapping。
        lines.push(`          ${key}: !!js '\`Bearer \${process.env.${match[1]}}\`'`)
      } else {
        lines.push(`          ${key}: ${yamlString(raw)}`)
      }
    }
  }
  lines.push(`        toolCallTimeoutMs: ${c.toolCallTimeoutMs}`)
  lines.push(`        failOnStartupError: ${c.failOnStartupError}`)
  return lines.join('\n')
}

/**
 * 将平台插件包部署到用户 dsh home 的 node_modules,并生成 profile patch。
 *
 * @param homeDir - 用户 dsh home。
 * @param mcpEntries - 该用户 authorized connector 渲染出的官方 mcp-client rows。
 */
export async function deployPlatformPatch(homeDir: string, mcpEntries: McpPatchEntry[] = []): Promise<string | null> {
  const insertRows: string[] = []

  for (const pkg of PLATFORM_PACKAGES) {
    const pkgRoot = path.resolve(config.repoRoot, pkg.src)
    // @scope/name → node_modules/@scope/name
    const targetDir = path.join(homeDir, 'node_modules', ...pkg.name.split('/'))
    await mkdir(targetDir, { recursive: true })
    // package.json 必需(exports/main 解析);lib/ 整体复制(Host 半区可能多模块)。
    await copyFile(path.join(pkgRoot, 'package.json'), path.join(targetDir, 'package.json'))
    await cp(path.join(pkgRoot, 'lib'), path.join(targetDir, 'lib'), { recursive: true })
    insertRows.push(`    - id: "${pkg.name}"\n      name: "${pkg.name}"`)
  }

  // 官方 MCP client rows(每 connector 一个 instance)。
  for (const entry of mcpEntries) {
    insertRows.push(renderMcpEntry(entry))
  }

  // Phase 07 E2E 专用 memory probe(仅 PLATFORM_E2E_MEMORY_PROBE=1;生产不启用)。
  if (process.env.PLATFORM_E2E_MEMORY_PROBE === '1') {
    insertRows.push('    - id: "cmcc-memory-probe"\n      name: "@dsh-platform/cmcc-memory-runtime/probe"')
  }

  const profilesDir = path.join(homeDir, 'profiles', 'web')
  await mkdir(profilesDir, { recursive: true })
  const patchPath = path.join(profilesDir, 'platform-patch.yml')

  const yaml = `# dsh-platform plugins - auto-generated
- insert:
${insertRows.join('\n')}
`

  await writeFile(patchPath, yaml, 'utf8')
  return patchPath
}