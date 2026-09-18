import { PageHeader, cardStyle, LoadingState } from '../components/StateViews.js'
import { useAsync } from '../hooks.js'
import { listSessions, listWorkspaces, listInstalledSkills, listMounts, listAuthorizedConnectors } from '../api.js'

const dshUrl = import.meta.env.VITE_DSH_UI_URL ?? 'http://localhost:8080/'

const CAPABILITIES = [
  { title: '开始对话', desc: '进入 Agent 工作台', path: dshUrl, external: true },
  { title: '技能广场', desc: '发现和安装技能', path: '/skills' },
  { title: '知识中心', desc: '管理知识库', path: '/knowledge' },
  { title: 'MCP 服务', desc: '连接外部工具', path: '/mcp' },
]

export function DashboardPage({ displayName, onNavigate }: {
  displayName: string
  onNavigate: (path: string) => void
}): JSX.Element {
  const sessions = useAsync(listSessions)
  const workspaces = useAsync(listWorkspaces)
  const skills = useAsync(listInstalledSkills)
  const mounts = useAsync(listMounts)
  const mcp = useAsync(listAuthorizedConnectors)

  const loading = sessions.loading && workspaces.loading && skills.loading && mounts.loading && mcp.loading

  return (
    <div style={{ maxWidth: '1040px' }}>
      <PageHeader title={`欢迎回来，${displayName}`} description="连接能力 · 协同智能 · 安全可控" />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '16px', marginBottom: '32px' }}>
        {CAPABILITIES.map((card) => (
          <button key={card.title} onClick={() => { if (card.external) window.location.href = card.path; else onNavigate(card.path) }}
            style={{ ...cardStyle, textAlign: 'left', cursor: 'pointer' }}>
            <div style={{ width: '36px', height: '36px', borderRadius: 'var(--radius-md)', background: 'var(--cmcc-primary-soft)', marginBottom: '12px' }} />
            <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--cmcc-text)', marginBottom: '4px' }}>{card.title}</h3>
            <p style={{ fontSize: '13px', color: 'var(--cmcc-text-secondary)' }}>{card.desc}</p>
          </button>
        ))}
      </div>

      <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '12px' }}>我的工作</h2>
      {loading ? <LoadingState /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px' }}>
          <SummaryCard title="最近会话" count={sessions.data?.sessions.length ?? 0} onClick={() => onNavigate('/sessions')} />
          <SummaryCard title="工作区" count={workspaces.data?.workspaces.length ?? 0} onClick={() => onNavigate('/workspaces')} />
          <SummaryCard title="已安装技能" count={skills.data?.skills.length ?? 0} onClick={() => onNavigate('/skills')} />
          <SummaryCard title="已挂载知识库" count={mounts.data?.mounts.length ?? 0} onClick={() => onNavigate('/knowledge')} />
          <SummaryCard title="已授权 MCP" count={mcp.data?.connectors.length ?? 0} onClick={() => onNavigate('/mcp')} />
        </div>
      )}
    </div>
  )
}

function SummaryCard({ title, count, onClick }: { title: string; count: number; onClick: () => void }): JSX.Element {
  return (
    <button onClick={onClick} style={{ ...cardStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', textAlign: 'left' }}>
      <span style={{ fontSize: '14px', color: 'var(--cmcc-text)' }}>{title}</span>
      <span style={{ fontSize: '20px', fontWeight: 600, color: 'var(--cmcc-primary)' }}>{count}</span>
    </button>
  )
}
