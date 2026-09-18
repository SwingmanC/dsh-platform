/**
 * 四个 Panel 共用的最小 UI 结构。
 *
 * 复用 DSH 语义设计 token(`--dsw-alias-*` / `--ds-*`),不引入 Tailwind/AntD/MUI,
 * 不复制旧 Portal Dashboard CSS。CSS Modules 需要官方 tsdown+lightningcss 管线,
 * 本阶段以 inline style + token 实现,记录为 follow-up。
 */
import * as React from 'react'
import type { CapabilityKey } from '../capability-status.js'
import { CAPABILITIES } from '../capability-status.js'

const T = {
  bg: 'var(--dsw-alias-bg-base, #ffffff)',
  panel: 'var(--dsw-alias-bg-layer-1, #ffffff)',
  border: 'var(--dsw-alias-border-l2, #e5e7eb)',
  text: 'var(--dsw-alias-label-primary, #1a2744)',
  text2: 'var(--dsw-alias-label-secondary, #5b6473)',
  accent: 'var(--dsw-alias-brand-primary, #1a6dff)',
  danger: 'var(--dsw-alias-label-danger, #d93025)',
  chip: 'var(--dsw-alias-interactive-bg-hover, #f2f4f7)',
} as const

export function PlatformPanel(props: { children: React.ReactNode }): React.ReactElement {
  return <div style={{ height: '100%', overflow: 'auto', background: T.bg, color: T.text }}>{props.children}</div>
}

export function PanelHeader(props: {
  title: string
  subtitle?: string
  capability: CapabilityKey
  actions?: React.ReactNode
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '18px 20px 12px' }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{props.title}</h2>
          <RuntimeStatusBadge capability={props.capability} />
        </div>
        {props.subtitle !== undefined && (
          <p style={{ margin: '6px 0 0', fontSize: 13, color: T.text2 }}>{props.subtitle}</p>
        )}
      </div>
      {props.actions !== undefined && <div style={{ display: 'flex', gap: 8 }}>{props.actions}</div>}
    </div>
  )
}

export function RuntimeStatusBadge(props: { capability: CapabilityKey }): React.ReactElement {
  const c = CAPABILITIES[props.capability]
  const connected = c.runtime === 'RUNTIME_CONNECTED'
  return (
    <span
      title={`Runtime Projection: ${c.runtime}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 11, lineHeight: '16px', padding: '1px 8px', borderRadius: 10,
        background: connected ? 'rgba(26,109,255,0.12)' : 'rgba(217,48,37,0.10)',
        color: connected ? T.accent : T.danger,
        border: `1px solid ${connected ? 'rgba(26,109,255,0.3)' : 'rgba(217,48,37,0.25)'}`,
      }}
    >
      <span aria-hidden="true">{connected ? '●' : '○'}</span>
      {connected ? 'Runtime 已接入' : 'Runtime 未接入'}
    </span>
  )
}

export function PanelToolbar(props: { children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '0 20px 12px' }}>
      {props.children}
    </div>
  )
}

export function PanelContent(props: { children: React.ReactNode }): React.ReactElement {
  return <div style={{ padding: '0 20px 24px' }}>{props.children}</div>
}

export function PanelLoading(props: { label?: string }): React.ReactElement {
  return (
    <div role="status" style={{ padding: 24, color: T.text2, fontSize: 13 }}>
      {props.label ?? '加载中…'}
    </div>
  )
}

export function PanelEmpty(props: { text: string; hint?: string }): React.ReactElement {
  return (
    <div style={{ padding: 24, border: `1px dashed ${T.border}`, borderRadius: 8, color: T.text2, fontSize: 13 }}>
      <div style={{ color: T.text, marginBottom: props.hint ? 4 : 0 }}>{props.text}</div>
      {props.hint !== undefined && <div>{props.hint}</div>}
    </div>
  )
}

export function PanelError(props: { message: string; onRetry: () => void }): React.ReactElement {
  return (
    <div role="alert" style={{ padding: 16, border: `1px solid rgba(217,48,37,0.3)`, borderRadius: 8, background: 'rgba(217,48,37,0.05)' }}>
      <div style={{ color: T.danger, fontSize: 13, marginBottom: 8 }}>{props.message}</div>
      <button type="button" onClick={props.onRetry} style={buttonStyle()}>重试</button>
    </div>
  )
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>): React.ReactElement {
  return (
    <input
      {...props}
      style={{
        padding: '6px 10px', fontSize: 13, borderRadius: 6, border: `1px solid ${T.border}`,
        background: T.panel, color: T.text, minWidth: 180, ...props.style,
      }}
    />
  )
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>): React.ReactElement {
  return (
    <select
      {...props}
      style={{
        padding: '6px 8px', fontSize: 13, borderRadius: 6, border: `1px solid ${T.border}`,
        background: T.panel, color: T.text, ...props.style,
      }}
    />
  )
}

export function buttonStyle(kind: 'primary' | 'ghost' = 'primary'): React.CSSProperties {
  return kind === 'primary'
    ? { background: T.accent, color: '#fff', border: 'none', borderRadius: 6, padding: '5px 12px', fontSize: 13, cursor: 'pointer' }
    : { background: 'transparent', color: T.text, border: `1px solid ${T.border}`, borderRadius: 6, padding: '5px 12px', fontSize: 13, cursor: 'pointer' }
}

export function Card(props: { children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: 12, marginBottom: 8, background: T.panel }}>
      {props.children}
    </div>
  )
}

export function Chip(props: { children: React.ReactNode }): React.ReactElement {
  return (
    <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 10, background: T.chip, color: T.text2 }}>
      {props.children}
    </span>
  )
}
