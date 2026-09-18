import { useState } from 'react'
import { PageHeader, cardStyle, LoadingState, EmptyState, ErrorState, PrimaryButton, GhostButton, StatusBadge } from '../components/StateViews.js'
import { useAsync } from '../hooks.js'
import { listMemory, createMemory, deleteMemory, promoteMemory } from '../api.js'

export function MemoryPage(): JSX.Element {
  const [tab, setTab] = useState<'personal' | 'tenant_shared'>('personal')
  const memory = useAsync(() => listMemory(tab), [tab])
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isPersonal = tab === 'personal'

  async function handleCreate(): Promise<void> {
    if (content.trim() === '') return
    setBusy(true); setError(null)
    try {
      await createMemory(content.trim())
      setContent('')
      memory.reload()
    } catch (err) { setError(`创建失败:${(err as Error).message}`) }
    finally { setBusy(false) }
  }

  async function handlePromote(id: string): Promise<void> {
    try { await promoteMemory(id); memory.reload() }
    catch (err) { setError(`提升失败:${(err as Error).message}`) }
  }
  async function handleDelete(id: string): Promise<void> {
    try { await deleteMemory(id); memory.reload() }
    catch (err) { setError(`删除失败:${(err as Error).message}`) }
  }

  return (
    <div style={{ maxWidth: '900px' }}>
      <PageHeader title={isPersonal ? '我的记忆' : '团队记忆'} description="个人记忆默认私有;团队记忆需显式提升" />

      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        <TabButton active={isPersonal} onClick={() => setTab('personal')}>个人记忆</TabButton>
        <TabButton active={!isPersonal} onClick={() => setTab('tenant_shared')}>团队记忆</TabButton>
      </div>

      {isPersonal && (
        <div style={{ ...cardStyle, display: 'flex', gap: '10px', marginBottom: '20px' }}>
          <input value={content} onChange={(e) => setContent(e.target.value)} placeholder="输入要记住的内容..."
            onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate() }}
            style={{ flex: 1, padding: '8px 12px', fontSize: '14px', border: '1px solid var(--cmcc-border)', borderRadius: 'var(--radius-sm)', outline: 'none' }} />
          <PrimaryButton onClick={handleCreate} disabled={busy || content.trim() === ''}>记住</PrimaryButton>
        </div>
      )}

      {error && <div style={{ marginBottom: '16px' }}><ErrorState message={error} /></div>}

      {memory.loading ? <LoadingState /> :
       memory.error ? <ErrorState message={memory.error} onRetry={memory.reload} /> :
       (memory.data?.records.length ?? 0) === 0 ? <EmptyState title="暂无记忆" hint={isPersonal ? '在上方输入内容创建' : '将个人记忆提升为团队后可见'} /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {memory.data!.records.map((m) => (
            <div key={m.id} style={cardStyle}>
              <p style={{ fontSize: '14px', color: 'var(--cmcc-text)', marginBottom: '8px', lineHeight: 1.6 }}>{m.content}</p>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', fontSize: '12px', color: 'var(--cmcc-text-secondary)' }}>
                  <StatusBadge tone={m.visibility === 'tenant_shared' ? 'green' : 'gray'}>
                    {m.visibility === 'tenant_shared' ? '团队共享' : '仅自己可见'}
                  </StatusBadge>
                  <span>来源: {sourceLabel(m.sourceType)}</span>
                  <span>{new Date(m.updatedAt).toLocaleDateString()}</span>
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  {isPersonal && <GhostButton onClick={() => handlePromote(m.id)}>提升为团队</GhostButton>}
                  {isPersonal && <GhostButton onClick={() => handleDelete(m.id)} danger>删除</GhostButton>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button onClick={onClick} style={{
      padding: '6px 16px', fontSize: '13px', borderRadius: '20px',
      border: '1px solid var(--cmcc-primary)',
      background: active ? 'var(--cmcc-primary)' : '#fff',
      color: active ? '#fff' : 'var(--cmcc-primary)',
    }}>{children}</button>
  )
}

function sourceLabel(s: string): string {
  return { user_fact: '用户', model_inferred: 'AI 提取', imported: '导入', team_approved: '团队' }[s] ?? s
}
