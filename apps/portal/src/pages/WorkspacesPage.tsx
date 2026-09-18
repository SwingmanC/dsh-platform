import { useState } from 'react'
import { PageHeader, cardStyle, LoadingState, EmptyState, ErrorState, PrimaryButton, StatusBadge } from '../components/StateViews.js'
import { useAsync } from '../hooks.js'
import { listWorkspaces, createWorkspace } from '../api.js'

export function WorkspacesPage(): JSX.Element {
  const ws = useAsync(listWorkspaces)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleCreate(): Promise<void> {
    if (name.trim() === '') return
    setBusy(true); setError(null)
    try {
      await createWorkspace(name.trim())
      setName('')
      ws.reload()
    } catch (err) {
      setError(`创建失败:${(err as Error).message}`)
    } finally { setBusy(false) }
  }

  return (
    <div style={{ maxWidth: '900px' }}>
      <PageHeader title="工作区" description="Agent 的文件操作根目录" />

      <div style={{ ...cardStyle, display: 'flex', gap: '10px', marginBottom: '20px' }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="新工作区名称"
          onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate() }}
          style={{ flex: 1, padding: '8px 12px', fontSize: '14px', border: '1px solid var(--cmcc-border)', borderRadius: 'var(--radius-sm)', outline: 'none' }} />
        <PrimaryButton onClick={handleCreate} disabled={busy || name.trim() === ''}>创建</PrimaryButton>
      </div>

      {error && <div style={{ marginBottom: '16px' }}><ErrorState message={error} /></div>}

      {ws.loading ? <LoadingState /> :
       ws.error ? <ErrorState message={ws.error} onRetry={ws.reload} /> :
       (ws.data?.workspaces.length ?? 0) === 0 ? <EmptyState title="暂无工作区" hint="在上方输入名称创建" /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {ws.data!.workspaces.map((w) => (
            <div key={w.id || w.canonicalPath} style={{ ...cardStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px' }}>
              <div style={{ minWidth: 0 }}>
                <p style={{ fontSize: '14px', fontWeight: 500, marginBottom: '4px' }}>{w.displayName}</p>
                <p style={{ fontSize: '12px', color: 'var(--cmcc-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.canonicalPath}</p>
              </div>
              <StatusBadge tone={w.exists ? 'green' : 'red'}>{w.exists ? '存在' : '缺失'}</StatusBadge>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
