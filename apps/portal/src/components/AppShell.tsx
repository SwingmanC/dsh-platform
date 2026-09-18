import type { ReactNode } from 'react'
import type { UserRole } from '@dsh-platform/shared'
import { Sidebar } from './Sidebar.js'
import { Topbar } from './Topbar.js'

export function AppShell({ role, displayName, tenantName, currentPath, onNavigate, onLogout, children }: {
  role?: UserRole
  displayName: string
  tenantName?: string
  currentPath: string
  onNavigate: (path: string) => void
  onLogout: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar role={role} currentPath={currentPath} onNavigate={onNavigate} />
      <div style={{ marginLeft: 'var(--sidebar-width)', flex: 1, display: 'flex', flexDirection: 'column' }}>
        <Topbar displayName={displayName} tenantName={tenantName} onLogout={onLogout} />
        <main style={{ flex: 1, padding: '24px', background: 'var(--cmcc-bg)' }}>
          {children}
        </main>
      </div>
    </div>
  )
}