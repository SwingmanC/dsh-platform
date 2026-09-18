import type { ReactNode } from 'react'

export function LoadingState({ label = '加载中...' }: { label?: string }): JSX.Element {
  return (
    <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--cmcc-text-secondary)', fontSize: '14px' }}>
      {label}
    </div>
  )
}

export function EmptyState({ title, hint }: { title: string; hint?: string }): JSX.Element {
  return (
    <div style={{
      padding: '48px 24px', textAlign: 'center', background: 'var(--cmcc-surface)',
      border: '1px dashed var(--cmcc-border)', borderRadius: 'var(--radius-lg)',
    }}>
      <p style={{ color: 'var(--cmcc-text)', fontSize: '15px', marginBottom: '4px' }}>{title}</p>
      {hint && <p style={{ color: 'var(--cmcc-text-secondary)', fontSize: '13px' }}>{hint}</p>}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }): JSX.Element {
  return (
    <div style={{
      padding: '24px', background: '#FEF2F2', border: '1px solid #FECACA',
      borderRadius: 'var(--radius-lg)', color: 'var(--cmcc-danger)', fontSize: '14px',
    }}>
      <p style={{ marginBottom: onRetry ? '12px' : 0 }}>{message}</p>
      {onRetry && (
        <button onClick={onRetry} style={{
          padding: '6px 14px', fontSize: '13px', border: '1px solid var(--cmcc-danger)',
          borderRadius: 'var(--radius-sm)', background: 'transparent', color: 'var(--cmcc-danger)',
        }}>重试</button>
      )}
    </div>
  )
}

export function PageHeader({ title, description, action }: {
  title: string
  description?: string
  action?: ReactNode
}): JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px', gap: '16px' }}>
      <div>
        <h1 style={{ fontSize: '22px', fontWeight: 600, color: 'var(--cmcc-text)' }}>{title}</h1>
        {description && <p style={{ fontSize: '13px', color: 'var(--cmcc-text-secondary)', marginTop: '4px' }}>{description}</p>}
      </div>
      {action}
    </div>
  )
}

export function StatusBadge({ tone, children }: { tone: 'blue' | 'green' | 'orange' | 'red' | 'gray'; children: ReactNode }): JSX.Element {
  const tones: Record<string, { bg: string; fg: string }> = {
    blue: { bg: '#E8F4FB', fg: '#0073B7' },
    green: { bg: '#F1F8E6', fg: '#2E9B4D' },
    orange: { bg: '#FFF4E5', fg: '#B25E09' },
    red: { bg: '#FEF2F2', fg: '#D92D20' },
    gray: { bg: '#F2F4F7', fg: '#667085' },
  }
  const t = tones[tone] ?? tones.gray!
  return (
    <span style={{ background: t.bg, color: t.fg, padding: '2px 10px', borderRadius: '10px', fontSize: '12px', whiteSpace: 'nowrap' }}>
      {children}
    </span>
  )
}

export function PrimaryButton({ children, onClick, disabled, type = 'button' }: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  type?: 'button' | 'submit'
}): JSX.Element {
  return (
    <button type={type} onClick={onClick} disabled={disabled} style={{
      padding: '8px 18px', fontSize: '14px', fontWeight: 500,
      background: 'var(--cmcc-primary)', color: '#fff', border: 'none',
      borderRadius: 'var(--radius-md)', opacity: disabled ? 0.6 : 1,
    }}>{children}</button>
  )
}

export function GhostButton({ children, onClick, danger }: {
  children: ReactNode
  onClick?: () => void
  danger?: boolean
}): JSX.Element {
  const color = danger ? 'var(--cmcc-danger)' : 'var(--cmcc-text-secondary)'
  return (
    <button onClick={onClick} style={{
      padding: '6px 14px', fontSize: '13px', background: 'var(--cmcc-surface)',
      border: `1px solid ${danger ? '#FECACA' : 'var(--cmcc-border)'}`,
      borderRadius: 'var(--radius-sm)', color,
    }}>{children}</button>
  )
}

export const cardStyle: React.CSSProperties = {
  background: 'var(--cmcc-surface)',
  border: '1px solid var(--cmcc-border)',
  borderRadius: 'var(--radius-lg)',
  padding: '16px 18px',
}
