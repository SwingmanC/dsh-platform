import type { UserRole } from '@dsh-platform/shared'

interface NavLink {
  label: string
  path: string
}

interface NavGroup {
  title?: string
  links: NavLink[]
}

const GROUPS: NavGroup[] = [
  {
    links: [
      { label: '首页', path: '/' },
      { label: '会话', path: '/sessions' },
      { label: '工作区', path: '/workspaces' },
    ],
  },
  {
    title: '能力中心',
    links: [
      { label: '技能广场', path: '/skills' },
      { label: '知识中心', path: '/knowledge' },
      { label: 'MCP 服务中心', path: '/mcp' },
    ],
  },
  {
    title: '个人能力',
    links: [
      { label: '我的记忆', path: '/memory' },
    ],
  },
]

export function Sidebar({ role, currentPath, onNavigate }: {
  role?: UserRole
  currentPath: string
  onNavigate: (path: string) => void
}): JSX.Element {
  const isAdmin = role === 'tenant_admin'

  return (
    <aside style={{
      width: 'var(--sidebar-width)', height: '100vh', background: 'var(--cmcc-surface)',
      borderRight: '1px solid var(--cmcc-border)', display: 'flex', flexDirection: 'column',
      position: 'fixed', left: 0, top: 0, zIndex: 100,
    }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--cmcc-border)' }}>
        <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--cmcc-text)' }}>中国移动</div>
        <div style={{ fontSize: '11px', color: 'var(--cmcc-text-secondary)' }}>数智智能体平台</div>
      </div>

      <nav style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {GROUPS.map((group, gi) => (
          <div key={gi} style={{ marginBottom: '4px' }}>
            {group.title && (
              <div style={{ padding: '10px 20px 4px', fontSize: '11px', color: 'var(--cmcc-text-secondary)', fontWeight: 500 }}>
                {group.title}
              </div>
            )}
            {group.links.map((link) => {
              const active = currentPath === link.path
              return (
                <button key={link.path} onClick={() => onNavigate(link.path)} style={{
                  display: 'block', width: '100%', padding: '9px 20px', textAlign: 'left',
                  background: active ? 'var(--cmcc-primary-soft)' : 'transparent',
                  color: active ? 'var(--cmcc-primary)' : 'var(--cmcc-text)',
                  border: 'none', borderRight: active ? '3px solid var(--cmcc-primary)' : '3px solid transparent',
                  fontSize: '14px', fontWeight: active ? 500 : 400,
                }}>{link.label}</button>
              )
            })}
          </div>
        ))}
        {isAdmin && (
          <div style={{ marginTop: '8px' }}>
            <div style={{ padding: '10px 20px 4px', fontSize: '11px', color: 'var(--cmcc-text-secondary)', fontWeight: 500 }}>管理</div>
            <div style={{ padding: '9px 20px', fontSize: '13px', color: 'var(--cmcc-text-secondary)' }}>团队 / 配额 / 审计(规划中)</div>
          </div>
        )}
      </nav>
    </aside>
  )
}
