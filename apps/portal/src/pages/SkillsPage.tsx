import { useState } from 'react'
import { PageHeader, cardStyle, LoadingState, EmptyState, ErrorState, PrimaryButton, GhostButton, StatusBadge } from '../components/StateViews.js'
import { useAsync } from '../hooks.js'
import { listSkills, listInstalledSkills, createSkill, installSkill, uninstallSkill, publishSkill } from '../api.js'

export function SkillsPage(): JSX.Element {
  const skills = useAsync(listSkills)
  const installed = useAsync(listInstalledSkills)
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const installedIds = new Set(installed.data?.skills.map((s) => s.id) ?? [])

  async function handleCreate(): Promise<void> {
    if (name.trim() === '') return
    setBusy(true); setError(null)
    try {
      await createSkill(name.trim(), desc.trim(), prompt.trim())
      setShowCreate(false); setName(''); setDesc(''); setPrompt('')
      skills.reload()
    } catch (err) { setError(`创建失败:${(err as Error).message}`) }
    finally { setBusy(false) }
  }

  async function toggleInstall(id: string, isInstalled: boolean): Promise<void> {
    try {
      if (isInstalled) await uninstallSkill(id); else await installSkill(id)
      installed.reload()
    } catch (err) { setError(`操作失败:${(err as Error).message}`) }
  }

  async function handlePublish(id: string): Promise<void> {
    try { await publishSkill(id); skills.reload() }
    catch (err) { setError(`发布失败:${(err as Error).message}`) }
  }

  return (
    <div style={{ maxWidth: '1040px' }}>
      <PageHeader title="技能广场" description="发现、安装和创建 Agent 技能"
        action={<PrimaryButton onClick={() => setShowCreate((v) => !v)}>创建技能</PrimaryButton>} />

      {error && <div style={{ marginBottom: '16px' }}><ErrorState message={error} /></div>}

      {showCreate && (
        <div style={{ ...cardStyle, marginBottom: '20px' }}>
          <h3 style={{ fontSize: '15px', fontWeight: 600, marginBottom: '14px' }}>新建技能</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="技能名称(必填)"
              style={inputStyle} />
            <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="一句话描述"
              style={inputStyle} />
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="技能指令内容" rows={4}
              style={{ ...inputStyle, resize: 'vertical' }} />
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <GhostButton onClick={() => setShowCreate(false)}>取消</GhostButton>
              <PrimaryButton onClick={handleCreate} disabled={busy || name.trim() === ''}>保存</PrimaryButton>
            </div>
          </div>
        </div>
      )}

      {skills.loading ? <LoadingState /> :
       skills.error ? <ErrorState message={skills.error} onRetry={skills.reload} /> :
       (skills.data?.skills.length ?? 0) === 0 ? <EmptyState title="暂无技能" hint="点击右上角创建第一个技能" /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '16px' }}>
          {skills.data!.skills.map((s) => {
            const isInstalled = installedIds.has(s.id)
            return (
              <div key={s.id} style={cardStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px', gap: '8px' }}>
                  <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--cmcc-text)' }}>{s.name}</h3>
                  <StatusBadge tone={visibilityTone(s.visibility)}>{visibilityLabel(s.visibility)}</StatusBadge>
                </div>
                <p style={{ fontSize: '13px', color: 'var(--cmcc-text-secondary)', marginBottom: '12px', minHeight: '36px' }}>
                  {s.description ?? '暂无描述'}
                </p>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--cmcc-text-secondary)' }}>v{s.latestVersion} · {s.installCount} 次安装</span>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {s.status === 'draft' && <GhostButton onClick={() => handlePublish(s.id)}>发布</GhostButton>}
                    {s.status === 'published' && (
                      <GhostButton onClick={() => toggleInstall(s.id, isInstalled)} danger={isInstalled}>
                        {isInstalled ? '卸载' : '安装'}
                      </GhostButton>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  padding: '8px 12px', fontSize: '14px', border: '1px solid var(--cmcc-border)',
  borderRadius: 'var(--radius-sm)', outline: 'none', fontFamily: 'inherit',
}

function visibilityLabel(v: string): string {
  return { private: '私有', tenant: '团队', public: '公开' }[v] ?? v
}
function visibilityTone(v: string): 'gray' | 'green' | 'blue' {
  return v === 'public' ? 'blue' : v === 'tenant' ? 'green' : 'gray'
}
