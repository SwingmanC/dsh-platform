import { useState } from 'react'
import { PageHeader, cardStyle, LoadingState, EmptyState, ErrorState, PrimaryButton, GhostButton, StatusBadge } from '../components/StateViews.js'
import { useAsync } from '../hooks.js'
import { listConnectors, createConnector, approveConnector, authorizeConnector } from '../api.js'

export function McpPage(): JSX.Element {
  const connectors = useAsync(listConnectors)
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [serverName, setServerName] = useState('')
  const [transport, setTransport] = useState<'streamable-http' | 'stdio'>('streamable-http')
  const [endpointUrl, setEndpointUrl] = useState('')
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleCreate(): Promise<void> {
    if (name.trim() === '' || serverName.trim() === '') return
    setBusy(true); setError(null)
    try {
      await createConnector({
        name: name.trim(), serverName: serverName.trim(), transport,
        endpointUrl: transport === 'streamable-http' ? endpointUrl.trim() : undefined,
        command: transport === 'stdio' ? command.trim() : undefined,
      })
      setShowCreate(false); setName(''); setServerName(''); setEndpointUrl(''); setCommand('')
      connectors.reload()
    } catch (err) { setError(`创建失败:${(err as Error).message}`) }
    finally { setBusy(false) }
  }

  async function handleApprove(id: string): Promise<void> {
    try { await approveConnector(id); connectors.reload() }
    catch (err) { setError(`审批失败:${(err as Error).message}`) }
  }
  async function handleAuthorize(id: string): Promise<void> {
    try { await authorizeConnector(id); connectors.reload() }
    catch (err) { setError(`授权失败:${(err as Error).message}`) }
  }

  return (
    <div style={{ maxWidth: '1040px' }}>
      <PageHeader title="MCP 服务中心" description="连接外部工具能力;stdio 服务需管理员审批"
        action={<PrimaryButton onClick={() => setShowCreate((v) => !v)}>新增服务</PrimaryButton>} />

      {error && <div style={{ marginBottom: '16px' }}><ErrorState message={error} /></div>}

      {showCreate && (
        <div style={{ ...cardStyle, marginBottom: '20px' }}>
          <h3 style={{ fontSize: '15px', fontWeight: 600, marginBottom: '14px' }}>新增 MCP 服务</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="显示名称" style={inputStyle} />
            <input value={serverName} onChange={(e) => setServerName(e.target.value)} placeholder="serverName (字母数字_-)" style={inputStyle} />
            <select value={transport} onChange={(e) => setTransport(e.target.value as 'streamable-http' | 'stdio')} style={inputStyle}>
              <option value="streamable-http">streamable-http(远程)</option>
              <option value="stdio">stdio(本地进程,需审批)</option>
            </select>
            {transport === 'streamable-http'
              ? <input value={endpointUrl} onChange={(e) => setEndpointUrl(e.target.value)} placeholder="https://..." style={inputStyle} />
              : <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="已审批的命令模板" style={inputStyle} />}
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <GhostButton onClick={() => setShowCreate(false)}>取消</GhostButton>
              <PrimaryButton onClick={handleCreate} disabled={busy || name.trim() === '' || serverName.trim() === ''}>保存</PrimaryButton>
            </div>
          </div>
        </div>
      )}

      {connectors.loading ? <LoadingState /> :
       connectors.error ? <ErrorState message={connectors.error} onRetry={connectors.reload} /> :
       (connectors.data?.connectors.length ?? 0) === 0 ? <EmptyState title="暂无 MCP 服务" hint="点击右上角新增" /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '16px' }}>
          {connectors.data!.connectors.map((c) => (
            <div key={c.id} style={cardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px', gap: '8px' }}>
                <h3 style={{ fontSize: '15px', fontWeight: 600 }}>{c.name}</h3>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <StatusBadge tone={c.transport === 'stdio' ? 'orange' : 'blue'}>{c.transport}</StatusBadge>
                  {c.transport === 'stdio' && <StatusBadge tone={c.approved ? 'green' : 'red'}>{c.approved ? '已审批' : '待审批'}</StatusBadge>}
                </div>
              </div>
              <p style={{ fontSize: '12px', color: 'var(--cmcc-text-secondary)', marginBottom: '4px' }}>serverName: {c.serverName}</p>
              {c.endpointUrl && <p style={{ fontSize: '12px', color: 'var(--cmcc-text-secondary)', marginBottom: '12px', wordBreak: 'break-all' }}>{c.endpointUrl}</p>}
              <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', marginTop: '12px' }}>
                {c.transport === 'stdio' && !c.approved && <GhostButton onClick={() => handleApprove(c.id)}>审批</GhostButton>}
                <GhostButton onClick={() => handleAuthorize(c.id)}>授权使用</GhostButton>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  padding: '8px 12px', fontSize: '14px', border: '1px solid var(--cmcc-border)',
  borderRadius: 'var(--radius-sm)', outline: 'none', fontFamily: 'inherit',
}
