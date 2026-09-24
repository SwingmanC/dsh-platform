import { useEffect, useState } from 'react'
import type { UsageSummaryResponse } from '@dsh-platform/shared'
import { getUsageSummary } from '../api.js'
import { PageHeader, cardStyle, LoadingState, ErrorState, EmptyState } from '../components/StateViews.js'

const fmt = new Intl.NumberFormat('zh-CN')

export function UsagePage(): JSX.Element {
  const [days, setDays] = useState<7 | 30 | 90>(30)
  const [data, setData] = useState<UsageSummaryResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setData(null); setError(null)
    void getUsageSummary(days).then(setData).catch((e: Error) => setError(e.message))
  }, [days])

  return <div style={{ maxWidth: '1100px' }}>
    <PageHeader title="用量统计" description="租户内 DSH 模型调用与 Token 消耗"
      action={<select value={days} onChange={(e) => setDays(Number(e.target.value) as 7 | 30 | 90)}
        style={{ padding: '8px 12px', border: '1px solid var(--cmcc-border)', borderRadius: 'var(--radius-md)', background: '#fff' }}>
        <option value={7}>最近 7 天</option><option value={30}>最近 30 天</option><option value={90}>最近 90 天</option>
      </select>} />
    {error ? <ErrorState message={`加载失败：${error}`} /> : !data ? <LoadingState /> : <UsageContent data={data} />}
  </div>
}

function UsageContent({ data }: { data: UsageSummaryResponse }): JSX.Element {
  const billedInput = data.totals.inputTokens + data.totals.cacheReadTokens + data.totals.cacheWriteTokens
  return <>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px', marginBottom: '24px' }}>
      <Metric label="模型请求" value={data.totals.requests} />
      <Metric label="输入 Token" value={billedInput} hint="含缓存读写" />
      <Metric label="输出 Token" value={data.totals.outputTokens} />
      <Metric label="推理 Token" value={data.totals.reasoningTokens} />
    </div>
    {data.daily.length === 0 ? <EmptyState title="暂无用量数据" hint="启动 DSH Runtime 并完成一次模型调用后，这里将显示统计。" /> : <>
      <Section title="每日趋势"><Bars rows={data.daily} /></Section>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        <Section title="人员用量"><Table headers={['人员', '请求', 'Token']} rows={data.users.map(u => [u.displayName, fmt.format(u.requests), fmt.format(u.inputTokens + u.outputTokens)])} /></Section>
        <Section title="模型用量"><Table headers={['模型', '请求', 'Token']} rows={data.models.map(m => [`${m.provider} / ${m.model}`, fmt.format(m.requests), fmt.format(m.inputTokens + m.outputTokens)])} /></Section>
      </div>
    </>}
  </>
}

function Metric({ label, value, hint }: { label: string; value: number; hint?: string }): JSX.Element {
  return <div style={cardStyle}><div style={{ fontSize: '13px', color: 'var(--cmcc-text-secondary)' }}>{label}</div>
    <div style={{ fontSize: '25px', fontWeight: 600, color: 'var(--cmcc-text)', marginTop: '8px' }}>{fmt.format(value)}</div>
    {hint && <div style={{ fontSize: '11px', color: 'var(--cmcc-text-secondary)', marginTop: '4px' }}>{hint}</div>}</div>
}
function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return <section style={{ ...cardStyle, marginBottom: '16px' }}><h2 style={{ fontSize: '15px', marginBottom: '16px' }}>{title}</h2>{children}</section>
}
function Bars({ rows }: { rows: UsageSummaryResponse['daily'] }): JSX.Element {
  const max = Math.max(...rows.map(r => r.inputTokens + r.outputTokens), 1)
  return <div style={{ display: 'flex', alignItems: 'flex-end', gap: '6px', height: '150px', overflowX: 'auto' }}>
    {rows.map(r => { const total = r.inputTokens + r.outputTokens; return <div key={r.day} title={`${r.day}: ${fmt.format(total)} Token`} style={{ minWidth: '18px', flex: 1, maxWidth: '42px', height: `${Math.max(4, total / max * 120)}px`, background: 'var(--cmcc-primary)', borderRadius: '3px 3px 0 0' }} /> })}
  </div>
}
function Table({ headers, rows }: { headers: string[]; rows: string[][] }): JSX.Element {
  return <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}><thead><tr>{headers.map(h => <th key={h} style={{ textAlign: 'left', padding: '8px', color: 'var(--cmcc-text-secondary)', borderBottom: '1px solid var(--cmcc-border)' }}>{h}</th>)}</tr></thead>
    <tbody>{rows.map((row, i) => <tr key={i}>{row.map((v, j) => <td key={j} style={{ padding: '9px 8px', borderBottom: '1px solid var(--cmcc-border)' }}>{v}</td>)}</tr>)}</tbody></table>
}
