import { useState } from 'react'
import type { SessionListItem } from '@dsh-platform/shared'
import { PageHeader, cardStyle, LoadingState, EmptyState, ErrorState, PrimaryButton, GhostButton, StatusBadge } from '../components/StateViews.js'
import { useAsync } from '../hooks.js'
import { listSessions, enterSession, recreateWorkspace } from '../api.js'

export function SessionsPage(): JSX.Element {
  const sessions = useAsync(listSessions)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [missing, setMissing] = useState<{ sessionId: string; workspace: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function handleEnter(sessionId: string): Promise<void> {
    setBusyId(sessionId); setNotice(null)
    try {
      const result = await enterSession(sessionId)
      if (result.ok) {
        window.location.href = result.redirectUrl
      } else {
        setMissing({ sessionId, workspace: result.workspace.canonicalPath })
      }
    } catch (err) {
      setNotice(`进入失败:${(err as Error).message}`)
    } finally { setBusyId(null) }
  }

  async function handleRecreate(sessionId: string): Promise<void> {
    setBusyId(sessionId)
    try {
      const r = await recreateWorkspace(sessionId)
      setMissing(null)
      window.location.href = r.redirectUrl
    } catch (err) {
      setNotice(`重建失败:${(err as Error).message}`)
    } finally { setBusyId(null) }
  }

  return (
    <div style={{ maxWidth: '900px' }}>
      <PageHeader title="历史会话" description="点击会话进入续聊;工作区缺失时可原路径重建" />
      {notice && <div style={{ marginBottom: '16px' }}><ErrorState message={notice} /></div>}

      {sessions.loading ? <LoadingState /> :
       sessions.error ? <ErrorState message={sessions.error} onRetry={sessions.reload} /> :
       (sessions.data?.sessions.length ?? 0) === 0 ? <EmptyState title="暂无历史会话" hint="进入 Agent 工作台创建第一个会话" /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {sessions.data!.sessions.map((s: SessionListItem) => (
            <div key={s.sessionId} style={{ ...cardStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px' }}>
              <div style={{ minWidth: 0 }}>
                <p style={{ fontSize: '14px', fontWeight: 500, color: 'var(--cmcc-text)', marginBottom: '4px' }}>
                  {s.title ?? '(无标题会话)'}
                </p>
                <p style={{ fontSize: '12px', color: 'var(--cmcc-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.workspace}
                </p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
                <StatusBadge tone="gray">{new Date(s.updatedAt).toLocaleDateString()}</StatusBadge>
                <PrimaryButton onClick={() => handleEnter(s.sessionId)} disabled={busyId === s.sessionId}>进入</PrimaryButton>
              </div>
            </div>
          ))}
        </div>
      )}

      {missing && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(23,33,43,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ ...cardStyle, width: '460px', maxWidth: '92vw', padding: '24px' }}>
            <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>当前工作区不存在</h3>
            <p style={{ fontSize: '13px', color: 'var(--cmcc-text-secondary)', marginBottom: '6px' }}>请选择/创建新的工作区。</p>
            <p style={{ fontSize: '12px', color: 'var(--cmcc-text-secondary)', marginBottom: '20px', wordBreak: 'break-all' }}>{missing.workspace}</p>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <GhostButton onClick={() => setMissing(null)}>取消</GhostButton>
              <PrimaryButton onClick={() => handleRecreate(missing.sessionId)} disabled={busyId === missing.sessionId}>原路径重建</PrimaryButton>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
