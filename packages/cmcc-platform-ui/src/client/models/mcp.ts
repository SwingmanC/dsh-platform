/**
 * MCP 面板 model:真实 connector 列表/创建/审批/授权/撤销/凭据 + Runtime 投影状态。
 *
 * 注意:授权成功 ≠ Agent 已获得工具。只有 Runtime evidence = CONNECTED
 * (observer 观测到 mcp__<server>__* 工具)才代表 Agent 工具可用。
 */
import type { MCPConnector } from './types.js'
import type { ResourceState } from './resource.js'
import { runLoad } from './resource.js'
import type { McpRuntimeStatus } from '../platform-api.js'

export interface McpApi {
  listConnectors(): Promise<{ connectors: MCPConnector[] }>
  listAuthorizedConnectors(): Promise<{ connectors: MCPConnector[] }>
  createConnector(input: {
    name: string; serverName: string; transport: string;
    command?: string; endpointUrl?: string; scope?: string; riskLevel?: string; visibility?: string
  }): Promise<MCPConnector>
  approveConnector(id: string): Promise<{ ok: true }>
  authorizeConnector(id: string): Promise<{ ok: true }>
  revokeConnector(id: string): Promise<{ ok: true }>
  disableConnector(id: string): Promise<{ ok: true }>
  saveConnectorCredential(id: string, secret: string): Promise<{ ok: true; configured: true }>
  getMcpRuntimeStatus?(): Promise<McpRuntimeStatus>
}

export interface McpPanelData {
  connectors: MCPConnector[]
  authorizedIds: string[]
  runtime: McpRuntimeStatus | null
}

export function loadMcp(api: McpApi): Promise<ResourceState<McpPanelData>> {
  return runLoad(async () => {
    const runtimePromise = typeof api.getMcpRuntimeStatus === 'function'
      ? api.getMcpRuntimeStatus().catch(() => null)
      : Promise.resolve(null)
    const [all, authorized, runtime] = await Promise.all([
      api.listConnectors(), api.listAuthorizedConnectors(), runtimePromise,
    ])
    return { connectors: all.connectors, authorizedIds: authorized.connectors.map((c) => c.id), runtime }
  }, (data) => data.connectors.length === 0)
}

export async function createConnectorAndReload(
  api: McpApi,
  input: {
    name: string; serverName: string; transport: string;
    command?: string; endpointUrl?: string; scope?: string; riskLevel?: string; visibility?: string
  },
): Promise<ResourceState<McpPanelData>> {
  await api.createConnector(input)
  return loadMcp(api)
}

export async function approveConnectorAndReload(api: McpApi, id: string): Promise<ResourceState<McpPanelData>> {
  await api.approveConnector(id)
  return loadMcp(api)
}

export async function authorizeConnectorAndReload(api: McpApi, id: string): Promise<ResourceState<McpPanelData>> {
  await api.authorizeConnector(id)
  return loadMcp(api)
}

export async function revokeConnectorAndReload(api: McpApi, id: string): Promise<ResourceState<McpPanelData>> {
  await api.revokeConnector(id)
  return loadMcp(api)
}

export async function disableConnectorAndReload(api: McpApi, id: string): Promise<ResourceState<McpPanelData>> {
  await api.disableConnector(id)
  return loadMcp(api)
}

export async function saveCredentialAndReload(api: McpApi, id: string, secret: string): Promise<ResourceState<McpPanelData>> {
  await api.saveConnectorCredential(id, secret)
  return loadMcp(api)
}

export function transportLabel(transport: string): string {
  return transport === 'stdio' ? 'stdio' : 'streamable-http'
}

export function riskLabel(risk: string): string {
  const map: Record<string, string> = { low: '低', medium: '中', high: '高' }
  return map[risk] ?? risk
}

export function mcpRuntimeStateLabel(state: string): string {
  const map: Record<string, string> = {
    CONNECTED: '已连接', SYNCING: '同步中', RESTART_REQUIRED: '需重启 Runtime',
    CONNECTING: '连接中', DEGRADED: '降级', ERROR: '错误',
    RUNTIME_STOPPED: 'Runtime 未运行', NOT_CONNECTED: '未接入',
  }
  return map[state] ?? state
}