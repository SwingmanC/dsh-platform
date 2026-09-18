export function Topbar({ displayName, tenantName, onLogout }: {
  displayName: string
  tenantName?: string
  onLogout: () => void
}): JSX.Element {
  return (
    <header style={{
      height: 'var(--topbar-height)', background: 'var(--cmcc-surface)',
      borderBottom: '1px solid var(--cmcc-border)',
      display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
      padding: '0 24px', gap: '16px',
    }}>
      {tenantName && (
        <span style={{ fontSize: '13px', color: 'var(--cmcc-text-secondary)', background: 'var(--cmcc-bg)', padding: '4px 10px', borderRadius: 'var(--radius-sm)' }}>
          {tenantName}
        </span>
      )}
      <span style={{ fontSize: '14px', color: 'var(--cmcc-text)', fontWeight: 500 }}>{displayName}</span>
      <button onClick={onLogout} style={{
        padding: '6px 14px', fontSize: '13px', border: '1px solid var(--cmcc-border)',
        borderRadius: 'var(--radius-sm)', background: 'var(--cmcc-surface)', color: 'var(--cmcc-text-secondary)',
      }}>退出</button>
    </header>
  )
}