/** 租户管理员在 DSH Shell 内查看模型调用用量。数据权限由 Gateway 校验。 */
import * as React from 'react'
import { platformApi } from '../platform-api.js'
import type { UsageSummary } from '../platform-api.js'
import { usageErrorMessage } from '../models/usage-error.js'
import { Card, PanelContent, PanelEmpty, PanelError, PanelLoading, PlatformPanel, Select } from '../components/PanelShell.js'

const fmt = new Intl.NumberFormat('zh-CN')
type Days = 7 | 30 | 90

export function UsagePanel(): React.ReactElement {
  const [days, setDays] = React.useState<Days>(30)
  const [nonce, setNonce] = React.useState(0)
  const [state, setState] = React.useState<
    { status: 'loading' } | { status: 'ready'; data: UsageSummary } | { status: 'error'; message: string }
  >({ status: 'loading' })

  React.useEffect(() => {
    let active = true
    setState({ status: 'loading' })
    void platformApi.getUsageSummary(days).then(
      (data) => { if (active) setState({ status: 'ready', data }) },
      (error: unknown) => { if (active) setState({ status: 'error', message: usageErrorMessage(error) }) },
    )
    return () => { active = false }
  }, [days, nonce])

  return <PlatformPanel>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, padding: '18px 20px 12px', flexWrap: 'wrap' }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 18 }}>用量统计</h2>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--dsw-alias-label-secondary, #5b6473)' }}>租户内 DSH 模型调用与 Token 消耗</p>
      </div>
      <Select aria-label="统计时间范围" value={days} onChange={(event) => setDays(Number(event.target.value) as Days)}>
        <option value={7}>最近 7 天</option>
        <option value={30}>最近 30 天</option>
        <option value={90}>最近 90 天</option>
      </Select>
    </div>
    <PanelContent>
      {state.status === 'loading' && <PanelLoading />}
      {state.status === 'error' && <PanelError message={state.message} onRetry={() => setNonce((value) => value + 1)} />}
      {state.status === 'ready' && <UsageContent data={state.data} />}
    </PanelContent>
  </PlatformPanel>
}

function UsageContent({ data }: { data: UsageSummary }): React.ReactElement {
  const input = data.totals.inputTokens + data.totals.cacheReadTokens + data.totals.cacheWriteTokens
  return <>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 16 }}>
      <Metric label="模型调用轮次" value={data.totals.requests} hint="同一轮的重试只算一次" />
      <Metric label="模型尝试记录" value={data.totals.attempts} hint={`其中 ${fmt.format(data.totals.nonSurfaceAttempts)} 次未生成最终消息`} />
      <Metric label="输入 Token" value={input} hint="含缓存读写" />
      <Metric label="输出 Token" value={data.totals.outputTokens} />
      <Metric label="推理 Token" value={data.totals.reasoningTokens} />
    </div>
    {data.totals.unknownUsageAttempts > 0 && <p role="status" style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--dsw-alias-label-secondary, #5b6473)' }}>
      {fmt.format(data.totals.unknownUsageAttempts)} 次模型尝试没有权威 Token 数据；已计入尝试次数，Token 未估算。
    </p>}
    {data.daily.length === 0 ? <PanelEmpty text="暂无用量数据" hint="完成一次模型调用后，这里将显示统计。" /> : <>
      <Section title="每日趋势"><DailyBars rows={data.daily} /></Section>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
        <Section title="人员用量"><UsageTable headers={['人员', '轮次', '尝试', 'Token']} rows={data.users.map((user) => [user.displayName, fmt.format(user.requests), fmt.format(user.attempts), fmt.format(user.inputTokens + user.outputTokens)])} /></Section>
        <Section title="模型用量"><UsageTable headers={['模型', '尝试', 'Token']} rows={data.models.map((model) => [`${model.provider} / ${model.model}`, fmt.format(model.attempts), fmt.format(model.inputTokens + model.outputTokens)])} /></Section>
      </div>
    </>}
  </>
}

function Metric({ label, value, hint }: { label: string; value: number; hint?: string }): React.ReactElement {
  return <Card>
    <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #5b6473)' }}>{label}</div>
    <div style={{ fontSize: 24, fontWeight: 600, marginTop: 6 }}>{fmt.format(value)}</div>
    {hint && <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #5b6473)' }}>{hint}</div>}
  </Card>
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return <Card><h3 style={{ fontSize: 15, margin: '0 0 12px' }}>{title}</h3>{children}</Card>
}

function DailyBars({ rows }: { rows: UsageSummary['daily'] }): React.ReactElement {
  const max = Math.max(1, ...rows.map((row) => row.inputTokens + row.outputTokens))
  return <div style={{ display: 'flex', gap: 5, alignItems: 'flex-end', height: 150, overflowX: 'auto' }}>
    {rows.map((row) => {
      const total = row.inputTokens + row.outputTokens
      return <div key={row.day} title={`${row.day} · ${fmt.format(total)} Token`} style={{ flex: '1 0 16px', maxWidth: 40, minWidth: 16, height: `${Math.max(4, total / max * 130)}px`, background: 'var(--dsw-alias-brand-primary, #1a6dff)', borderRadius: '3px 3px 0 0' }} />
    })}
  </div>
}

function UsageTable({ headers, rows }: { headers: string[]; rows: string[][] }): React.ReactElement {
  return <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
    <thead><tr>{headers.map((header) => <th key={header} style={cellStyle}>{header}</th>)}</tr></thead>
    <tbody>{rows.map((row, index) => <tr key={index}>{row.map((value, column) => <td key={column} style={cellStyle}>{value}</td>)}</tr>)}</tbody>
  </table></div>
}

const cellStyle: React.CSSProperties = { textAlign: 'left', padding: '8px 6px', borderBottom: '1px solid var(--dsw-alias-border-l2, #e5e7eb)' }
