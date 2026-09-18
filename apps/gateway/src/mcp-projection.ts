/**
 * MCP Runtime 投影(Gateway-owned derived projection)。
 *
 * 架构:
 *   Platform DB(authoritative:connector catalog + approval + authorization + encrypted credential)
 *     → Gateway 判定 transport policy / credential 完整性
 *     → 生成每用户投影(mcp-projection.json,desired revision)
 *     → 生成官方 `@deepseek-ai/dsh-mcp-client` plugin rows(patch)
 *     → Runtime 启动时注入解密后的 secret 到 child env
 *     → DSH 官方 mcp-client 连接并注册 `mcp__<serverName>__<tool>`
 *
 * 安全:
 * - 路径由服务端 principal 生成(tenantId/userId UUID)。
 * - 投影文件只含 secret env reference(变量名),不含 secret value。
 * - ordinary user 不能提交任意 command/url;url 来自 approved template。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import { mcpRepository } from './repositories/mcp-repository.js'
import type { ProjectableConnector } from './repositories/mcp-repository.js'

const UUID_RE = /^[0-9a-fA-F-]{36}$/
export const MCP_PROJECTION_SCHEMA_VERSION = 1
export const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/

export type McpTransportPolicy = 'streamable-http' | 'stdio'

export interface ProjectedServer {
  connectorId: string
  serverName: string
  transport: McpTransportPolicy
  url: string | null
  /** secret 环境变量名(仅引用,不含 value)。 */
  credentialEnvVar: string | null
  authType: string | null
  toolCallTimeoutMs: number
}

export interface McpProjection {
  schemaVersion: number
  revision: string
  generatedAt: string
  tenantId: string
  userId: string
  servers: ProjectedServer[]
  /** 被排除的 connector(结构化原因,无 secret)。 */
  excluded: Array<{ connectorId: string; reason: string }>
}

export interface McpProjectionBuildResult {
  revision: string
  serverCount: number
  excluded: Array<{ connectorId: string; reason: string }>
}

function safeSegment(value: string): string {
  if (!UUID_RE.test(value)) throw new Error(`unsafe mcp projection path: ${value}`)
  return value
}

export function mcpProjectionDir(tenantId: string, userId: string): string {
  return path.join(config.mcp.projectionsRoot, safeSegment(tenantId), safeSegment(userId), 'mcp')
}

/** 稳定、不可逆的 credential env 变量名(不含 display name 用户输入)。 */
export function credentialEnvVarName(connectorId: string): string {
  const hash = createHash('sha256').update(connectorId).digest('hex').slice(0, 16).toUpperCase()
  return `CMCC_MCP_SECRET_${hash}`
}

export interface McpEgressPolicy {
  allowedOrigins: readonly string[]
  allowLoopback: boolean
}

function currentEgressPolicy(): McpEgressPolicy {
  return { allowedOrigins: config.mcp.allowedOrigins, allowLoopback: config.mcp.allowLoopback }
}

/** 校验 streamable-http URL 是否符合 SSRF / egress policy。 */
export function validateMcpUrl(
  rawUrl: string,
  policy: McpEgressPolicy = currentEgressPolicy(),
): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'invalid-url' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, reason: 'invalid-scheme' }
  if (parsed.username !== '' || parsed.password !== '') return { ok: false, reason: 'userinfo-not-allowed' }
  if (parsed.hash !== '') return { ok: false, reason: 'fragment-not-allowed' }
  const origin = parsed.origin
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1'
  if (policy.allowedOrigins.includes(origin)) return { ok: true, url: parsed.toString() }
  if (loopback && policy.allowLoopback) return { ok: true, url: parsed.toString() }
  return { ok: false, reason: 'origin-not-allowed' }
}

/**
 * 判定 connector 能否进入 Runtime:
 * approved + active(SQL 已保证)+ transport policy + 配置完整 + credential 状态。
 */
export async function evaluateConnector(c: ProjectableConnector): Promise<
  { ok: true; server: ProjectedServer } | { ok: false; reason: string }
> {
  if (!SERVER_NAME_RE.test(c.serverName)) return { ok: false, reason: 'invalid-server-name' }
  const needsCredential = c.authType !== null && c.authType !== '' && c.authType !== 'none'
  let credentialEnvVar: string | null = null
  if (needsCredential) {
    const has = await mcpRepository.hasCredential(c.id)
    if (!has) return { ok: false, reason: 'missing-credential' }
    credentialEnvVar = credentialEnvVarName(c.id)
  }
  if (c.transport === 'streamable-http') {
    if (c.endpointUrl === null || c.endpointUrl === '') return { ok: false, reason: 'missing-url' }
    const v = validateMcpUrl(c.endpointUrl)
    if (!v.ok) return { ok: false, reason: v.reason }
    return {
      ok: true,
      server: {
        connectorId: c.id, serverName: c.serverName, transport: 'streamable-http', url: v.url,
        credentialEnvVar, authType: c.authType, toolCallTimeoutMs: config.mcp.toolCallTimeoutMs,
      },
    }
  }
  if (c.transport === 'stdio') {
    if (!config.mcp.allowStdio) return { ok: false, reason: 'stdio-disabled-by-policy' }
    return { ok: false, reason: 'stdio-not-enabled-in-phase-06' }
  }
  return { ok: false, reason: 'unsupported-transport' }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, file)
}

function revisionOf(servers: ProjectedServer[]): string {
  const normalized = servers.map((s) => ({ ...s })).sort((a, b) => a.serverName.localeCompare(b.serverName))
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16)
}

/**
 * 构建某用户当前 MCP 投影。authorize/revoke/approve/disable/credential/start 时调用。
 */
export async function buildMcpProjection(tenantId: string, userId: string): Promise<McpProjectionBuildResult> {
  const dir = mcpProjectionDir(tenantId, userId)
  const rows = await mcpRepository.listProjectableAuthorized(userId, tenantId)
  const servers: ProjectedServer[] = []
  const excluded: Array<{ connectorId: string; reason: string }> = []
  for (const c of rows) {
    const decision = await evaluateConnector(c)
    if (decision.ok) servers.push(decision.server)
    else excluded.push({ connectorId: c.id, reason: decision.reason })
  }
  servers.sort((a, b) => a.serverName.localeCompare(b.serverName))
  const revision = revisionOf(servers)
  const projection: McpProjection = {
    schemaVersion: MCP_PROJECTION_SCHEMA_VERSION, revision, generatedAt: new Date().toISOString(),
    tenantId, userId, servers, excluded,
  }
  await mkdir(dir, { recursive: true })
  await atomicWrite(path.join(dir, 'mcp-projection.json'), JSON.stringify(projection, null, 2))
  await atomicWrite(path.join(dir, 'status.json'), JSON.stringify({
    desiredRevision: revision, generatedAt: projection.generatedAt, serverCount: servers.length,
  }, null, 2))
  return { revision, serverCount: servers.length, excluded }
}

export async function readMcpProjection(tenantId: string, userId: string): Promise<McpProjection | null> {
  try {
    return JSON.parse(await readFile(path.join(mcpProjectionDir(tenantId, userId), 'mcp-projection.json'), 'utf8')) as McpProjection
  } catch {
    return null
  }
}

/** cmcc-mcp-observer 写入的观测 evidence(真实 ctx.tools mcp__* 工具)。 */
export interface McpAck {
  observedRevision: string
  lastObservedAt: string
  error: string | null
  servers: Array<{ serverName: string; toolCount: number; tools: string[] }>
  toolCount: number
}

export async function readMcpAck(tenantId: string, userId: string): Promise<McpAck | null> {
  try {
    return JSON.parse(await readFile(path.join(mcpProjectionDir(tenantId, userId), 'ack.json'), 'utf8')) as McpAck
  } catch {
    return null
  }
}

export interface McpProjectionStatus {
  state: 'RUNTIME_STOPPED' | 'SYNCING' | 'RESTART_REQUIRED' | 'CONNECTING' | 'CONNECTED' | 'DEGRADED' | 'ERROR' | 'NOT_CONNECTED'
  desiredRevision: string | null
  observedRevision: string | null
  lastObservedAt: string | null
  error: string | null
  serverCount: number
  generatedAt: string | null
}

export async function readMcpProjectionStatus(
  tenantId: string, userId: string, runtimeState: string | undefined,
): Promise<McpProjectionStatus> {
  const dir = mcpProjectionDir(tenantId, userId)
  const status = await readJson<{ desiredRevision: string; generatedAt: string; serverCount: number }>(path.join(dir, 'status.json'))
  const ack = await readJson<{ observedRevision: string; lastObservedAt: string; error?: string }>(path.join(dir, 'ack.json'))
  const desiredRevision = status?.desiredRevision ?? null
  const observedRevision = ack?.observedRevision ?? null
  let state: McpProjectionStatus['state']
  if (runtimeState !== 'ready') state = 'RUNTIME_STOPPED'
  else if (typeof ack?.error === 'string' && ack.error !== '') state = 'ERROR'
  else if (desiredRevision === null) state = 'NOT_CONNECTED'
  else if (observedRevision === desiredRevision) state = 'CONNECTED'
  else state = 'SYNCING'
  return {
    state, desiredRevision, observedRevision,
    lastObservedAt: ack?.lastObservedAt ?? null, error: ack?.error ?? null,
    serverCount: status?.serverCount ?? 0, generatedAt: status?.generatedAt ?? null,
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T } catch { return null }
}

/** 生成官方 dsh-mcp-client plugin row 的 patch 条目(不含 secret value)。 */
export interface McpPatchEntry {
  id: string
  name: string
  config: Record<string, unknown>
}

export function renderMcpPatchEntries(projection: McpProjection): McpPatchEntry[] {
  return projection.servers.map((s) => ({
    id: `cmcc-mcp-${s.connectorId}`,
    name: '@deepseek-ai/dsh-mcp-client',
    config: {
      serverName: s.serverName,
      transport: 'streamable-http',
      url: s.url,
      headers: s.credentialEnvVar === null
        ? {}
        : { Authorization: `Bearer \${process.env.${s.credentialEnvVar}}` },
      toolCallTimeoutMs: s.toolCallTimeoutMs,
      failOnStartupError: false,
    },
  }))
}