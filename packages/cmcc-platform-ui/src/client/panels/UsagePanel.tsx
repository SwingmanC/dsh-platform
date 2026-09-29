/** 租户管理员在 DSH Shell 内查看模型调用用量。数据权限由 Gateway 校验。 */
import * as React from 'react'
import { platformApi } from '../platform-api.js'
import type { UsageCounts, UsageSummary } from '../platform-api.js'
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
  const totals = data.totals
  const input = knownInput(totals)
  return <>
    <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--dsw-alias-label-secondary, #5b6473)' }}>
      调用轮次按用户、会话和 turn 去重；模型尝试按每条结算事件计数。输入 = 未缓存输入 + 缓存读取 + 缓存写入；推理 Token 已包含在输出中。
    </p>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 16 }}>
      <Metric label="模型调用轮次" value={totals.turns} hint="同一轮的重试只算一次" />
      <Metric label="模型尝试次数" value={totals.attempts} hint={`其中 ${fmt.format(totals.nonSurfaceAttempts)} 次未生成最终消息`} />
      <Metric label="已记录输入 Token" value={input} hint="未缓存 + 缓存读取 + 缓存写入" />
      <Metric label="已记录输出 Token" value={totals.outputTokens} />
      <Metric label="未缓存输入" value={totals.inputTokens} />
      <Metric label="缓存读取" value={knownValue(totals.cacheReadTokens, totals.cacheReadKnownAttempts, totals.attempts)} hint={coverage(totals.cacheReadKnownAttempts, totals.attempts)} />
      <Metric label="缓存写入" value={knownValue(totals.cacheWriteTokens, totals.cacheWriteKnownAttempts, totals.attempts)} hint={coverage(totals.cacheWriteKnownAttempts, totals.attempts)} />
      <Metric label="其中推理 Token" value={knownValue(totals.reasoningTokens, totals.reasoningKnownAttempts, totals.attempts)} hint={coverage(totals.reasoningKnownAttempts, totals.attempts)} />
    </div>
    {(totals.unknownUsageAttempts > 0 || totals.cacheReadKnownAttempts < totals.attempts || totals.cacheWriteKnownAttempts < totals.attempts) && <p role="status" style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--dsw-alias-label-secondary, #5b6473)' }}>
      有未上报的 Token 字段时，“已记录”合计只包含可确认的数值；表格中的 * 表示部分记录未上报该项。{totals.unknownUsageAttempts > 0 ? `${fmt.format(totals.unknownUsageAttempts)} 次尝试完全没有权威用量。` : ''}
    </p>}
    {data.daily.length === 0 ? <PanelEmpty text="暂无用量数据" hint="完成一次模型调用后，这里将显示统计。" /> : <>
      <Section title="每日趋势"><DailyBars rows={data.daily} /></Section>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
        <Section title="人员用量"><UsageTable headers={['人员', '轮次', '尝试', '未缓存输入', '缓存读取', '缓存写入', '输出', '已记录合计']} rows={data.users.map((user) => [user.displayName, fmt.format(user.turns), fmt.format(user.attempts), fmt.format(user.inputTokens), knownValue(user.cacheReadTokens, user.cacheReadKnownAttempts, user.attempts), knownValue(user.cacheWriteTokens, user.cacheWriteKnownAttempts, user.attempts), fmt.format(user.outputTokens), fmt.format(knownInput(user) + user.outputTokens)])} /></Section>
        <Section title="模型用量"><UsageTable headers={['模型', '尝试', '未缓存输入', '缓存读取', '缓存写入', '输出', '已记录合计']} rows={data.models.map((model) => [`${model.provider} / ${model.model}`, fmt.format(model.attempts), fmt.format(model.inputTokens), knownValue(model.cacheReadTokens, model.cacheReadKnownAttempts, model.attempts), knownValue(model.cacheWriteTokens, model.cacheWriteKnownAttempts, model.attempts), fmt.format(model.outputTokens), fmt.format(knownInput(model) + model.outputTokens)])} /></Section>
      </div>
    </>}
  </>
}

function knownInput(row: UsageCounts): number {
  return row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens
}

function knownValue(value: number, knownAttempts: number, attempts: number): string {
  if (attempts > 0 && knownAttempts === 0) return '未上报'
  return `${fmt.format(value)}${knownAttempts < attempts ? '*' : ''}`
}

function coverage(knownAttempts: number, attempts: number): string {
  return `${fmt.format(knownAttempts)} / ${fmt.format(attempts)} 次尝试提供了该项`
}

function Metric({ label, value, hint }: { label: string; value: number | string; hint?: string }): React.ReactElement {
  return <Card>
    <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #5b6473)' }}>{label}</div>
    <div style={{ fontSize: 24, fontWeight: 600, marginTop: 6 }}>{typeof value === 'number' ? fmt.format(value) : value}</div>
    {hint && <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #5b6473)' }}>{hint}</div>}
  </Card>
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return <Card><h3 style={{ fontSize: 15, margin: '0 0 12px' }}>{title}</h3>{children}</Card>
}

function DailyBars({ rows }: { rows: UsageSummary['daily'] }): React.ReactElement {
  const max = Math.max(1, ...rows.map((row) => knownInput(row) + row.outputTokens))
  return <div role="list" style={{ display: 'grid', gap: 14, maxHeight: 320, overflowY: 'auto' }}>
    {rows.map((row) => {
      const total = knownInput(row) + row.outputTokens
      return <div role="listitem" key={row.day}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
          <time dateTime={row.day}>{row.day}</time>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>已记录 {fmt.format(total)} Token · {fmt.format(row.attempts)} 次尝试</span>
        </div>
        <div aria-label={`${row.day} 已记录 ${fmt.format(total)} Token`} role="img" style={{ height: 10, marginTop: 6, borderRadius: 5, background: 'rgba(127,127,127,0.18)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${total === 0 ? 0 : Math.max(3, total / max * 100)}%`, background: 'var(--dsw-alias-brand-primary, #1a6dff)', opacity: 0.75 }} />
        </div>
        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--dsw-alias-label-secondary, #5b6473)' }}>
          未缓存 {fmt.format(row.inputTokens)} · 缓存读 {knownValue(row.cacheReadTokens, row.cacheReadKnownAttempts, row.attempts)} · 缓存写 {knownValue(row.cacheWriteTokens, row.cacheWriteKnownAttempts, row.attempts)} · 输出 {fmt.format(row.outputTokens)}
        </div>
      </div>
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
