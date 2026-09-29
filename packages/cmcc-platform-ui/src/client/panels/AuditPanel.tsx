import * as React from 'react'
import type { AuditListQuery, AuditListResponse, AuditLogItem, AuditResult } from '@dsh-platform/shared'
import { platformApi } from '../platform-api.js'
import { AUDIT_ACTIONS, AUDIT_RESULTS, AUDIT_RESOURCES, auditErrorMessage, auditTime } from '../models/audit.js'
import { PlatformPanel, PanelContent, PanelLoading, PanelError, PanelEmpty, TextInput, Select, buttonStyle } from '../components/PanelShell.js'

const border = 'var(--dsw-alias-border-l2, #e5e7eb)'
const secondary = 'var(--dsw-alias-label-secondary, #5b6473)'
const cell: React.CSSProperties = { padding: 12, borderBottom: `1px solid ${border}`, overflowWrap: 'anywhere' }
const sources = { gateway: '网关', runtime: '运行时', system: '系统' }
const actorLabel = (item: AuditLogItem): string => item.actorName ?? item.actor ?? (item.source === 'system' ? '系统' : '未记录')
const colors = { SUCCESS: '#16803c', DENIED: '#9a6700', ERROR: '#d93025' }
const initial = { actorName: '', action: '', resourceType: '', result: '', from: '', to: '' }

export function AuditPanel(): React.ReactElement {
  const [admin, setAdmin] = React.useState(false)
  const [data, setData] = React.useState<AuditListResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [formError, setFormError] = React.useState('')
  const [draft, setDraft] = React.useState(initial)
  const [query, setQuery] = React.useState<AuditListQuery>({ page: 1, pageSize: 20 })
  const [revision, setRevision] = React.useState(0)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [detail, setDetail] = React.useState<AuditLogItem | null>(null)
  const [detailError, setDetailError] = React.useState('')
  const [detailRevision, setDetailRevision] = React.useState(0)
  const closeRef = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    let active = true
    setLoading(true); setError(''); setData(null)
    void (async () => {
      const me = await platformApi.getCurrentUser()
      if (!active) return
      setAdmin(me.role === 'tenant_admin')
      if (me.role !== 'tenant_admin') { setSelectedId(null); setError('仅租户管理员可查看审计日志。'); return }
      const result = await platformApi.listAuditEvents(query)
      if (active) setData(result)
    })().catch((err: unknown) => { if (active) { setError(auditErrorMessage(err)); setData(null); setSelectedId(null) } })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [query, revision])

  React.useEffect(() => {
    if (!selectedId) return
    let active = true
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSelectedId(null)
      // The only interactive controls in the drawer are close/retry.
      if (event.key === 'Tab') {
        const controls = closeRef.current?.parentElement?.querySelectorAll<HTMLButtonElement>('button')
        if (!controls?.length) return
        const first = controls[0]; const last = controls[controls.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', onKey)
    setDetail(null); setDetailError('')
    void platformApi.getAuditEvent(selectedId).then((item) => { if (active) setDetail(item) })
      .catch((err: unknown) => { if (active) setDetailError(auditErrorMessage(err)) })
    return () => { active = false; document.removeEventListener('keydown', onKey); previous?.focus() }
  }, [selectedId, detailRevision])

  function search(event: React.FormEvent): void {
    event.preventDefault(); setFormError('')
    const from = draft.from ? new Date(draft.from) : null
    const to = draft.to ? new Date(draft.to) : null
    if ((from && !Number.isFinite(from.getTime())) || (to && !Number.isFinite(to.getTime())) || (from && to && from > to)) {
      setFormError('开始时间须早于或等于结束时间。'); return
    }
    setQuery({ actorName: draft.actorName.trim() || undefined, action: draft.action || undefined,
      resourceType: draft.resourceType || undefined, result: (draft.result || undefined) as AuditResult | undefined,
      from: from?.toISOString(), to: to?.toISOString(), page: 1, pageSize: query.pageSize })
  }

  return <PlatformPanel>
    <div style={{ padding: 20 }}><h2 style={{ margin: 0, fontSize: 18 }}>审计日志</h2>
      <p style={{ margin: '8px 0 0', fontSize: 13, color: secondary }}>查看本租户的登录、人员管理及平台资源变更记录。历史记录缺失的字段显示为“未记录”。</p></div>
    <PanelContent>
      {admin && <form onSubmit={search} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16, alignItems: 'center' }}>
        <TextInput aria-label="操作人姓名" placeholder="操作人姓名" maxLength={128} value={draft.actorName} onChange={(e) => setDraft({ ...draft, actorName: e.target.value })} />
        <Select aria-label="操作类型" value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })}><option value="">全部操作</option>
          {Object.entries(AUDIT_ACTIONS).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</Select>
        <Select aria-label="资源类型" value={draft.resourceType} onChange={(e) => setDraft({ ...draft, resourceType: e.target.value })}><option value="">全部资源</option>
          {Object.entries(AUDIT_RESOURCES).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</Select>
        <Select aria-label="操作结果" value={draft.result} onChange={(e) => setDraft({ ...draft, result: e.target.value })}><option value="">全部结果</option>
          {Object.entries(AUDIT_RESULTS).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</Select>
        <label style={{ fontSize: 13 }}>开始时间 <TextInput aria-label="开始时间" type="datetime-local" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} /></label>
        <label style={{ fontSize: 13 }}>结束时间 <TextInput aria-label="结束时间" type="datetime-local" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></label>
        <button type="submit" style={buttonStyle()}>查询</button>
        <button type="button" style={buttonStyle('ghost')} onClick={() => { setDraft(initial); setFormError(''); setQuery({ page: 1, pageSize: query.pageSize }) }}>重置</button>
        <button type="button" style={buttonStyle('ghost')} onClick={() => setRevision((v) => v + 1)}>刷新</button>
      </form>}
      {formError && <p role="alert">{formError}</p>}
      {loading ? <PanelLoading /> : error ? <PanelError message={error} onRetry={() => setRevision((v) => v + 1)} /> : data && <>
        {data.items.length === 0 ? <PanelEmpty text="没有符合条件的审计记录" hint="调整筛选条件后重试。" /> : <div style={{ overflowX: 'auto', border: `1px solid ${border}`, borderRadius: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, textAlign: 'left', minWidth: 900 }}>
            <thead><tr>{['时间', '操作人', '操作', '对象', '结果', '来源 IP', '详情'].map((label) => <th key={label} style={{ ...cell, color: secondary }}>{label}</th>)}</tr></thead>
            <tbody>{data.items.map((item) => <tr key={item.id}>
              <td style={cell}>{auditTime(item.at)}</td><td style={cell}>{actorLabel(item)}</td>
              <td style={cell}>{AUDIT_ACTIONS[item.action] ?? item.action}</td>
              <td style={{ ...cell, maxWidth: 280 }}>{item.resourceType ? (AUDIT_RESOURCES[item.resourceType] ?? item.resourceType) : '未记录'}<br />{item.resourceId ?? item.subject ?? '未记录'}</td>
              <td style={{ ...cell, color: item.result ? colors[item.result] : secondary }}>{item.result ? AUDIT_RESULTS[item.result] : '未记录'}</td>
              <td style={cell}>{item.clientIp ?? '未记录'}</td><td style={cell}><button type="button" style={buttonStyle('ghost')} onClick={() => { setDetail(null); setDetailError(''); setSelectedId(item.id) }}>查看</button></td>
            </tr>)}</tbody>
          </table></div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginTop: 16, fontSize: 13 }}>
          <span>共 {data.total} 条 · 第 {data.page} / {Math.max(1, Math.ceil(data.total / data.pageSize))} 页</span>
          <button type="button" disabled={data.page <= 1} style={buttonStyle('ghost')} onClick={() => setQuery({ ...query, page: data.page - 1 })}>上一页</button>
          <button type="button" disabled={data.page * data.pageSize >= data.total} style={buttonStyle('ghost')} onClick={() => setQuery({ ...query, page: data.page + 1 })}>下一页</button>
          <Select aria-label="每页条数" value={query.pageSize} onChange={(e) => setQuery({ ...query, page: 1, pageSize: Number(e.target.value) })}>{[20, 50, 100].map((n) => <option key={n} value={n}>{n} 条/页</option>)}</Select>
        </div>
      </>}
    </PanelContent>
    {selectedId && admin && <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.25)', zIndex: 1000 }} onClick={() => setSelectedId(null)}>
      <aside role="dialog" aria-modal="true" aria-labelledby="audit-detail-title" onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 'min(560px, 100%)', boxSizing: 'border-box', padding: 24, overflow: 'auto', background: 'var(--dsw-alias-bg-base, #fff)' }}>
        <button ref={closeRef} type="button" style={{ ...buttonStyle('ghost'), float: 'right' }} onClick={() => setSelectedId(null)}>关闭</button>
        <h3 id="audit-detail-title">审计详情</h3>
        {detailError ? <PanelError message={detailError} onRetry={() => setDetailRevision((v) => v + 1)} /> : !detail ? <PanelLoading /> : <>
          <dl style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{Object.entries({ '记录 ID': detail.id, '时间': auditTime(detail.at), '操作人': actorLabel(detail),
            '操作人 ID': detail.actor, '操作': `${AUDIT_ACTIONS[detail.action] ?? detail.action} (${detail.action})`, '资源类型': detail.resourceType,
            '资源 ID': detail.resourceId ?? detail.subject, '结果': detail.result ? AUDIT_RESULTS[detail.result] : null, '原因码': detail.reasonCode,
            '请求 ID': detail.requestId, '来源': detail.source ? sources[detail.source] : null, '来源 IP': detail.clientIp, '客户端': detail.userAgent }).map(([label, value]) => <React.Fragment key={label}>
              <dt style={{ marginTop: 12, color: secondary }}>{label}</dt><dd style={{ margin: '4px 0 0' }}>{value ?? '未记录'}</dd>
            </React.Fragment>)}</dl>
          <h4>变更摘要</h4><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 }}>{detail.payload ? JSON.stringify(detail.payload, null, 2) : '未记录'}</pre>
        </>}
      </aside>
    </div>}
  </PlatformPanel>
}
