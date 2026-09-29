/**
 * MCP 面板 —— MCP 服务。
 *
 * Phase 06:真实 connector 列表/创建/审批/授权/撤销/凭据 + Runtime 投影 evidence。
 * 授权成功 ≠ Agent 已获得工具;只有 Runtime CONNECTED(observer 观测到 mcp__* 工具)
 * 才显示「Agent Tools 已连接」。
 */
import * as React from 'react'
import { platformApi } from '../platform-api.js'
import type { MCPConnector } from '../models/types.js'
import {
  approveConnectorAndReload, authorizeConnectorAndReload, createConnectorAndReload,
  disableConnectorAndReload, loadMcp, mcpRuntimeStateLabel, revokeConnectorAndReload,
  riskLabel, saveCredentialAndReload, transportLabel,
} from '../models/mcp.js'
import type { McpPanelData, McpTestResult } from '../models/mcp.js'
import { useAsyncState, useMutation } from '../components/hooks.js'
import {
  Card, Chip, PanelContent, PanelEmpty, PanelError, PanelHeader, PanelLoading,
  PanelToolbar, PlatformPanel, Select, TextInput, buttonStyle,
} from '../components/PanelShell.js'

export function McpPanel(): React.ReactElement {
  const [showCreate, setShowCreate] = React.useState(false)
  const [name, setName] = React.useState('')
  const [serverName, setServerName] = React.useState('')
  const [transport, setTransport] = React.useState('streamable-http')
  const [endpointUrl, setEndpointUrl] = React.useState('')
  const [command, setCommand] = React.useState('')
  const [scope, setScope] = React.useState('user')
  const [riskLevel, setRiskLevel] = React.useState('low')
  const [credentialFor, setCredentialFor] = React.useState<string | null>(null)
  const [catalogFor, setCatalogFor] = React.useState<string | null>(null)
  const [secret, setSecret] = React.useState('')

  const { state, reload, setState } = useAsyncState<McpPanelData>(() => loadMcp(platformApi), [])
  const mutation = useMutation()
  const afterMutation = (next: Awaited<ReturnType<typeof loadMcp>>): void => { setState(next) }

  const canCreate = name.trim() !== '' && serverName.trim() !== ''
    && (transport === 'stdio' ? command.trim() !== '' : endpointUrl.trim() !== '')

  return (
    <PlatformPanel>
      <PanelHeader
        title="MCP 服务"
        subtitle="平台连接器注册表(DB)+ 官方 dsh-mcp-client Runtime 投影。授权 + 审批后经投影进入 Runtime。"
        capability="mcp"
      />
      {state.status === 'ready' && state.data.runtime !== null && (
        <PanelContent>
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #5b6473)', marginBottom: 8 }}>
            {`Runtime 投影:${mcpRuntimeStateLabel(state.data.runtime.state)}`
              + ` · desired=${state.data.runtime.desiredRevision ?? '—'} observed=${state.data.runtime.observedRevision ?? '—'}`
              + ` · servers=${state.data.runtime.observedServers.length}/${state.data.runtime.desiredServers.length}`
              + ` · tools=${state.data.runtime.observedToolCount}`
              + ` · apply=${state.data.runtime.applyMode}`}
          </div>
        </PanelContent>
      )}
      <PanelToolbar>
        <button type="button" style={buttonStyle()} onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? '取消' : '新建连接器'}
        </button>
        {mutation.pending && <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #5b6473)' }}>处理中…</span>}
      </PanelToolbar>

      {showCreate && (
        <PanelContent>
          <Card>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 560 }}>
              <TextInput placeholder="显示名称(必填)" value={name} onChange={(e) => setName(e.target.value)} />
              <TextInput placeholder="serverName(必填,[A-Za-z0-9_-]{1,32})" value={serverName} onChange={(e) => setServerName(e.target.value)} />
              <Select value={transport} onChange={(e) => setTransport(e.target.value)}>
                <option value="streamable-http">streamable-http</option>
                <option value="stdio">stdio</option>
              </Select>
              {transport === 'streamable-http'
                ? <TextInput placeholder="endpointUrl(必填,来自已审批模板)" value={endpointUrl} onChange={(e) => setEndpointUrl(e.target.value)} />
                : <TextInput placeholder="command(需管理员策略放行)" value={command} onChange={(e) => setCommand(e.target.value)} />}
              <div style={{ display: 'flex', gap: 8 }}>
                <Select value={scope} onChange={(e) => setScope(e.target.value)}>
                  <option value="user">user</option>
                  <option value="tenant">tenant</option>
                  <option value="platform">platform</option>
                </Select>
                <Select value={riskLevel} onChange={(e) => setRiskLevel(e.target.value)}>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </Select>
              </div>
              <button
                type="button"
                style={buttonStyle()}
                disabled={mutation.pending || !canCreate}
                onClick={() => mutation.run(
                  () => createConnectorAndReload(platformApi, {
                    name: name.trim(), serverName: serverName.trim(), transport, scope, riskLevel,
                    ...(transport === 'stdio' ? { command: command.trim() } : { endpointUrl: endpointUrl.trim() }),
                  }),
                  (next) => {
                    afterMutation(next)
                    if (next.status !== 'error') {
                      setName(''); setServerName(''); setEndpointUrl(''); setCommand(''); setShowCreate(false)
                    }
                  },
                )}
              >
                创建
              </button>
            </div>
          </Card>
        </PanelContent>
      )}

      {mutation.error !== null && <PanelContent><PanelError message={mutation.error} onRetry={reload} /></PanelContent>}

      <PanelContent>
        {state.status === 'loading' && <PanelLoading />}
        {state.status === 'error' && <PanelError message={state.message} onRetry={reload} />}
        {state.status === 'empty' && <PanelEmpty text="暂无 MCP 连接器" hint="点击「新建连接器」创建第一个" />}
        {state.status === 'ready' && state.data.connectors.map((c) => {
          const connected = state.data.runtime?.state === 'CONNECTED'
            && state.data.runtime.observedServers.includes(c.serverName)
          return (
            <ConnectorCard
              key={c.id}
              connector={c}
              authorized={state.data.authorizedIds.includes(c.id)}
              agentConnected={connected}
              pending={mutation.pending}
              credentialOpen={credentialFor === c.id}
              catalogOpen={catalogFor === c.id}
              secret={secret}
              onSecretChange={setSecret}
              onApprove={() => mutation.run(() => approveConnectorAndReload(platformApi, c.id), afterMutation)}
              onAuthorize={() => mutation.run(() => authorizeConnectorAndReload(platformApi, c.id), afterMutation)}
              onRevoke={() => mutation.run(() => revokeConnectorAndReload(platformApi, c.id), afterMutation)}
              onDisable={() => mutation.run(() => disableConnectorAndReload(platformApi, c.id), afterMutation)}
              onToggleCredential={() => { setCredentialFor(credentialFor === c.id ? null : c.id); setSecret('') }}
              onToggleCatalog={() => setCatalogFor(catalogFor === c.id ? null : c.id)}
              onTested={() => reload()}
              onSaveCredential={() => mutation.run(
                () => saveCredentialAndReload(platformApi, c.id, secret),
                (next) => { afterMutation(next); setCredentialFor(null); setSecret('') },
              )}
            />
          )
        })}
      </PanelContent>
    </PlatformPanel>
  )
}

function ConnectorCard(props: {
  connector: MCPConnector
  authorized: boolean
  agentConnected: boolean
  pending: boolean
  credentialOpen: boolean
  catalogOpen: boolean
  secret: string
  onSecretChange: (v: string) => void
  onApprove: () => void
  onAuthorize: () => void
  onRevoke: () => void
  onDisable: () => void
  onToggleCredential: () => void
  onToggleCatalog: () => void
  onTested: () => void
  onSaveCredential: () => void
}): React.ReactElement {
  const { connector: c } = props
  // 连接测试(启用前探针):本地状态,与面板级 mutation 互不阻塞。
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<McpTestResult | null>(null)
  // MCP-V1.1:持久化 discovery snapshot 展开(刷新后仍可见,数据源 = connector DTO)
  const [showCatalog, setShowCatalog] = React.useState(false)
  const runTest = (): void => {
    setTesting(true)
    setTestResult(null)
    platformApi.testConnector(c.id)
      .then((r) => setTestResult(r))
      .catch((e: unknown) => setTestResult({
        ok: false, code: 'request-error', message: (e as Error).message, durationMs: 0, authConfigured: false,
      }))
      .finally(() => { setTesting(false); props.onTested() })
  }
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 14 }}>{c.name}</strong>
            <Chip>{transportLabel(c.transport)}</Chip>
            <Chip>风险 {riskLabel(c.riskLevel)}</Chip>
            <Chip>{c.approved ? '已审批' : '未审批'}</Chip>
            {c.status !== 'active' && <Chip>{c.status}</Chip>}
            {props.authorized && <Chip>平台已授权</Chip>}
            {props.agentConnected && <Chip>Agent Tools 已连接</Chip>}
          </div>
          <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--dsw-alias-label-secondary, #5b6473)' }}>
            server={c.serverName}{c.endpointUrl !== null ? ` · ${c.endpointUrl}` : c.command !== null ? ` · ${c.command}` : ''}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
          <button type="button" style={buttonStyle('ghost')} disabled={testing || props.pending} onClick={runTest}>
            {testing ? '测试中…' : '测试'}
          </button>
          <button type="button" style={buttonStyle('ghost')} disabled={props.pending} onClick={props.onToggleCatalog}>
            {props.catalogOpen ? '收起目录' : `工具目录${(props.connector.discoveredTools?.length ?? 0) > 0 ? `(${props.connector.discoveredTools!.length})` : ''}`}
          </button>
          {!c.approved && (
            <button type="button" style={buttonStyle('ghost')} disabled={props.pending} onClick={props.onApprove}>审批</button>
          )}
          {c.approved && !props.authorized && (
            <button type="button" style={buttonStyle()} disabled={props.pending} onClick={props.onAuthorize}>授权</button>
          )}
          {props.authorized && (
            <button type="button" style={buttonStyle('ghost')} disabled={props.pending} onClick={props.onRevoke}>撤销</button>
          )}
          <button type="button" style={buttonStyle('ghost')} disabled={props.pending} onClick={props.onToggleCredential}>
            {props.credentialOpen ? '取消' : '凭据'}
          </button>
          {c.approved && c.status === 'active' && (
            <button type="button" style={buttonStyle('ghost')} disabled={props.pending} onClick={props.onDisable}>停用</button>
          )}
        </div>
      </div>
      {props.catalogOpen && (
        <ToolCatalogView
          tools={c.discoveredTools ?? []}
          emptyText="No tools discovered(先执行「测试」完成 discovery)"
        />
      )}
      {props.credentialOpen && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <TextInput
            type="password"
            placeholder="credential(仅提交,永不回显)"
            value={props.secret}
            onChange={(e) => props.onSecretChange(e.target.value)}
          />
          <button type="button" style={buttonStyle()} disabled={props.pending || props.secret.trim() === ''} onClick={props.onSaveCredential}>
            保存
          </button>
        </div>
      )}
      {testResult !== null && <TestResultView result={testResult} />}
    </Card>
  )
}

/** 连接测试结果(脱敏后的错误消息 / 工具预览)。 */
function TestResultView(props: { result: McpTestResult }): React.ReactElement {
  const r = props.result
  if (!r.ok) {
    return (
      <div style={{ marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-status-danger, #c0392b)' }}>
        {`连接失败:${r.message ?? r.code ?? 'unknown'}(${r.durationMs}ms)`}
      </div>
    )
  }
  const tools = r.tools ?? []
  const shown = tools.slice(0, 12)
  return (
    <div style={{ marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-status-success, #1e7e34)' }}>
      <div>
        {`连接成功 · 工具 ${r.toolCount ?? tools.length} 个 · ${r.durationMs}ms`}
        {r.authConfigured ? ' · 已携带凭据' : ' · 未携带凭据'}
      </div>
      {shown.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
          {shown.map((t) => (
            <span
              key={t.name}
              title={t.description ?? t.name}
              style={{ border: '1px solid var(--dsw-alias-border-subtle, #d7dbe2)', borderRadius: 4, padding: '1px 6px' }}
            >
              {t.name}
            </span>
          ))}
          {tools.length > shown.length && <span>+{tools.length - shown.length} 更多</span>}
        </div>
      )}
      {/* MCP-V1.1:完整 Tool Preview(name/description/inputSchema;数据为只读展示) */}
      <ToolCatalogView tools={tools.map((t) => ({ ...t, ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}) }))} />
    </div>
  )
}

/** 工具目录展示:name/description + 只读 inputSchema(不执行、不渲染 HTML)。 */
function ToolCatalogView(props: {
  tools: Array<{ name: string; description: string | null; inputSchema?: Record<string, unknown> }>
  emptyText?: string
}): React.ReactElement {
  const tools = props.tools ?? []
  if (tools.length === 0) {
    return <div style={{ marginTop: 4, fontSize: 12, color: 'var(--dsw-alias-label-secondary, #5b6473)' }}>{props.emptyText ?? 'No tools discovered'}</div>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
      {tools.map((t) => (
        <div key={t.name} style={{ border: '1px solid var(--dsw-alias-border-subtle, #d7dbe2)', borderRadius: 6, padding: '6px 8px' }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>{t.name}</div>
          {t.description !== null && t.description !== '' && (
            <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #5b6473)' }}>{t.description}</div>
          )}
          {t.inputSchema !== undefined && Object.keys(t.inputSchema).length > 0 && (
            <pre style={{ margin: '4px 0 0', fontSize: 10, background: 'var(--dsw-alias-bg-subtle, #f5f6f8)', borderRadius: 4, padding: '4px 6px', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {JSON.stringify(t.inputSchema, null, 2)}
            </pre>
          )}
        </div>
      ))}
    </div>
  )
}