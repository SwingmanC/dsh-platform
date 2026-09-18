import { useState } from 'react'
import { PageHeader, cardStyle, LoadingState, EmptyState, ErrorState, PrimaryButton, GhostButton, StatusBadge } from '../components/StateViews.js'
import { useAsync } from '../hooks.js'
import { listKnowledgeBases, createKnowledgeBase, mountKnowledgeBase, listMounts } from '../api.js'

export function KnowledgePage(): JSX.Element {
  const kbs = useAsync(listKnowledgeBases)
  const mounts = useAsync(listMounts)
  const [name, setName] = useState('')
  const [visibility, setVisibility] = useState<'personal' | 'tenant'>('personal')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const mountedIds = new Set(mounts.data?.mounts.map((m) => m.id) ?? [])

  async function handleCreate(): Promise<void> {
    if (name.trim() === '') return
    setBusy(true); setError(null)
    try {
      await createKnowledgeBase(name.trim(), visibility)
      setName('')
      kbs.reload()
    } catch (err) { setError(`创建失败:${(err as Error).message}`) }
    finally { setBusy(false) }
  }

  async function handleMount(id: string): Promise<void> {
    try { await mountKnowledgeBase(id); mounts.reload() }
    catch (err) { setError(`挂载失败:${(err as Error).message}`) }
  }

  return (
    <div style={{ maxWidth: '1040px' }}>
      <PageHeader title="知识中心" description="个人与团队知识库,支持文档检索与挂载" />

      <div style={{ ...cardStyle, display: 'flex', gap: '10px', marginBottom: '20px', flexWrap: 'wrap' }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="新知识库名称"
          style={{ flex: 1, minWidth: '200px', padding: '8px 12px', fontSize: '14px', border: '1px solid var(--cmcc-border)', borderRadius: 'var(--radius-sm)', outline: 'none' }} />
        <select value={visibility} onChange={(e) => setVisibility(e.target.value as 'personal' | 'tenant')}
          style={{ padding: '8px 12px', fontSize: '14px', border: '1px solid var(--cmcc-border)', borderRadius: 'var(--radius-sm)' }}>
          <option value="personal">仅自己可见</option>
          <option value="tenant">团队共享</option>
        </select>
        <PrimaryButton onClick={handleCreate} disabled={busy || name.trim() === ''}>创建</PrimaryButton>
      </div>

      {error && <div style={{ marginBottom: '16px' }}><ErrorState message={error} /></div>}

      {kbs.loading ? <LoadingState /> :
       kbs.error ? <ErrorState message={kbs.error} onRetry={kbs.reload} /> :
       (kbs.data?.knowledgeBases.length ?? 0) === 0 ? <EmptyState title="暂无知识库" hint="在上方创建第一个知识库" /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '16px' }}>
          {kbs.data!.knowledgeBases.map((kb) => (
            <div key={kb.id} style={cardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px', gap: '8px' }}>
                <h3 style={{ fontSize: '15px', fontWeight: 600 }}>{kb.name}</h3>
                <StatusBadge tone={kb.visibility === 'tenant' ? 'green' : 'gray'}>
                  {kb.visibility === 'tenant' ? '团队共享' : '仅自己可见'}
                </StatusBadge>
              </div>
              <p style={{ fontSize: '13px', color: 'var(--cmcc-text-secondary)', marginBottom: '12px' }}>
                {kb.description ?? `${kb.docCount} 个文档`}
              </p>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '12px', color: 'var(--cmcc-text-secondary)' }}>{kb.docCount} 文档</span>
                {mountedIds.has(kb.id)
                  ? <StatusBadge tone="blue">已挂载</StatusBadge>
                  : <GhostButton onClick={() => handleMount(kb.id)}>挂载</GhostButton>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
