import * as React from 'react'
import type { ManagedUser, MeResponse, UserListResponse, UserRole, UserStatus } from '@dsh-platform/shared'
import { platformApi } from '../platform-api.js'
import { USER_ROLES, userErrorMessage } from '../models/users.js'
import { PlatformPanel, PanelContent, PanelLoading, PanelError, PanelEmpty, TextInput, Select, buttonStyle } from '../components/PanelShell.js'

type Dialog = { kind: 'create' } | { kind: 'edit' | 'password' | 'status' | 'delete'; user: ManagedUser }
const border = 'var(--dsw-alias-border-l2, #e5e7eb)'
const secondary = 'var(--dsw-alias-label-secondary, #5b6473)'

export function UsersPanel(): React.ReactElement {
  const [me, setMe] = React.useState<MeResponse | null>(null)
  const [data, setData] = React.useState<UserListResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [q, setQ] = React.useState('')
  const [role, setRole] = React.useState('')
  const [status, setStatus] = React.useState('')
  const [filters, setFilters] = React.useState({ q: '', role: '', status: '', page: 1 })
  const [revision, setRevision] = React.useState(0)
  const [dialog, setDialog] = React.useState<Dialog | null>(null)

  React.useEffect(() => {
    let active = true
    setLoading(true); setError('')
    void (async () => {
      const identity = await platformApi.getCurrentUser()
      if (!active) return
      setMe(identity)
      if (identity.role !== 'tenant_admin') { setError('仅租户管理员可管理人员。'); setData(null); return }
      const result = await platformApi.listUsers({ q: filters.q || undefined, role: (filters.role || undefined) as UserRole | undefined,
        status: (filters.status || undefined) as UserStatus | undefined, page: filters.page, pageSize: 20 })
      if (active) {
        const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize))
        if (filters.page > lastPage) setFilters((v) => ({ ...v, page: lastPage }))
        else setData(result)
      }
    })().catch((err: unknown) => { if (active) { setError(userErrorMessage(err)); setData(null) } })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [filters, revision])

  const admin = me?.role === 'tenant_admin'
  return <PlatformPanel>
    <div style={{ padding: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 16 }}>
      <div><h2 style={{ margin: 0, fontSize: 18 }}>人员管理</h2>
        <p style={{ margin: '8px 0 0', fontSize: 13, color: secondary }}>管理本租户成员的登录账号、角色和启用状态。</p></div>
      {admin && <button type="button" style={buttonStyle()} onClick={() => { setNotice(''); setDialog({ kind: 'create' }) }}>添加人员</button>}
    </div>
    <PanelContent>
      {admin && <form onSubmit={(e) => { e.preventDefault(); setFilters({ q, role, status, page: 1 }) }}
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <TextInput aria-label="搜索人员" placeholder="搜索姓名或邮箱" maxLength={128} value={q} onChange={(e) => setQ(e.target.value)} />
        <Select aria-label="筛选角色" value={role} onChange={(e) => setRole(e.target.value)}><option value="">全部角色</option>
          {Object.entries(USER_ROLES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>
        <Select aria-label="筛选状态" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">全部状态</option><option value="active">启用</option><option value="disabled">停用</option></Select>
        <button type="submit" style={buttonStyle()}>查询</button>
        <button type="button" style={buttonStyle('ghost')} onClick={() => { setQ(''); setRole(''); setStatus(''); setFilters({ q: '', role: '', status: '', page: 1 }) }}>重置</button>
      </form>}
      {notice && <p role="status" style={{ fontSize: 13 }}>{notice}</p>}
      {loading ? <PanelLoading /> : error ? <PanelError message={error} onRetry={() => setRevision((v) => v + 1)} />
        : data && <>
          {data.users.length === 0 ? <PanelEmpty text="没有符合条件的人员" hint="调整筛选条件，或添加新的成员。" /> :
            <div style={{ overflowX: 'auto', border: `1px solid ${border}`, borderRadius: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, textAlign: 'left', minWidth: 760 }}>
                <thead><tr>{['姓名', '登录邮箱', '角色', '状态', '创建时间', '操作'].map((label) => <th key={label} style={{ padding: '12px', borderBottom: `1px solid ${border}`, color: secondary }}>{label}</th>)}</tr></thead>
                <tbody>{data.users.map((user) => <tr key={user.id}>
                  <td style={cell}>{user.displayName}{user.id === me?.userId && <span style={{ color: secondary }}>（我）</span>}</td>
                  <td style={cell}>{user.email}</td><td style={cell}>{USER_ROLES[user.role]}</td>
                  <td style={cell}><span style={{ color: user.status === 'active' ? 'var(--dsw-alias-brand-primary, #1a6dff)' : secondary }}>{user.status === 'active' ? '启用' : '停用'}</span></td>
                  <td style={cell}>{new Date(user.createdAt).toLocaleDateString()}</td>
                  <td style={{ ...cell, whiteSpace: 'nowrap' }}>
                    <button style={buttonStyle('ghost')} onClick={() => setDialog({ kind: 'edit', user })}>编辑</button>{' '}
                    <button style={buttonStyle('ghost')} onClick={() => setDialog({ kind: 'password', user })}>重置密码</button>{' '}
                    <button style={buttonStyle('ghost')} disabled={user.id === me?.userId} title={user.id === me?.userId ? '不能停用当前登录账号' : undefined}
                      onClick={() => setDialog({ kind: 'status', user })}>{user.status === 'active' ? '停用' : '启用'}</button>{' '}
                    <button style={{ ...buttonStyle('ghost'), color: 'var(--dsw-alias-label-danger, #d93025)' }}
                      disabled={user.id === me?.userId} title={user.id === me?.userId ? '不能删除当前登录账号' : undefined}
                      onClick={() => setDialog({ kind: 'delete', user })}>删除</button>
                  </td>
                </tr>)}</tbody>
              </table>
            </div>}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, fontSize: 13 }}>
            <span style={{ color: secondary }}>共 {data.total} 人 · 第 {data.page} 页</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={buttonStyle('ghost')} disabled={data.page <= 1} onClick={() => setFilters((v) => ({ ...v, page: v.page - 1 }))}>上一页</button>
              <button style={buttonStyle('ghost')} disabled={data.page * data.pageSize >= data.total} onClick={() => setFilters((v) => ({ ...v, page: v.page + 1 }))}>下一页</button>
            </div>
          </div>
        </>}
    </PanelContent>
    {dialog && <UserDialog dialog={dialog} selfId={me?.userId ?? ''} onClose={() => setDialog(null)} onDone={(message, selfRevoked) => {
      setDialog(null); setNotice(message)
      if (selfRevoked) { setError('账号安全信息已更新，请重新登录。'); setData(null); setMe(null) }
      else setRevision((v) => v + 1)
    }} />}
  </PlatformPanel>
}

const cell: React.CSSProperties = { padding: '12px', borderBottom: `1px solid ${border}`, maxWidth: 260, overflowWrap: 'anywhere' }

function UserDialog({ dialog, selfId, onClose, onDone }: { dialog: Dialog; selfId: string; onClose: () => void; onDone: (message: string, selfRevoked: boolean) => void }): React.ReactElement {
  const user = dialog.kind === 'create' ? null : dialog.user
  const [displayName, setName] = React.useState(user?.displayName ?? '')
  const [email, setEmail] = React.useState(user?.email ?? '')
  const [role, setRole] = React.useState<UserRole>(user?.role ?? 'member')
  const [password, setPassword] = React.useState('')
  const [confirmation, setConfirmation] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const modal = React.useRef<HTMLDialogElement>(null)
  const title = dialog.kind === 'create' ? '添加人员' : dialog.kind === 'edit' ? '编辑人员' : dialog.kind === 'password' ? '重置密码' : dialog.kind === 'delete' ? '删除人员' : user?.status === 'active' ? '停用账号' : '启用账号'
  React.useEffect(() => { modal.current?.showModal() }, [])

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (busy) return
    if ((dialog.kind === 'create' || dialog.kind === 'password') && password !== confirmation) { setError('两次输入的密码不一致。'); return }
    setBusy(true); setError('')
    try {
      const result = dialog.kind === 'create' ? await platformApi.createUser({ displayName, email, role, password })
        : dialog.kind === 'delete' ? await platformApi.deleteUser(dialog.user.id)
        : dialog.kind === 'password' ? await platformApi.resetUserPassword(dialog.user.id, password)
          : dialog.kind === 'status' ? await platformApi.updateUser(dialog.user.id, { status: dialog.user.status === 'active' ? 'disabled' : 'active' })
            : await platformApi.updateUser(dialog.user.id, { displayName, email, role })
      setPassword(''); setConfirmation('')
      const selfRevoked = user?.id === selfId && (dialog.kind === 'password' || (dialog.kind === 'edit' && email.trim().toLowerCase() !== user.email))
      onDone(result.runtimeStopped ? `${title}成功。` : `${title}已保存，旧会话已失效；运行时回收失败，请联系运维处理。`, selfRevoked)
    } catch (err) { setError(userErrorMessage(err)) } finally { setBusy(false) }
  }

  return <dialog ref={modal} aria-label={title} onCancel={(e) => { e.preventDefault(); if (!busy) onClose() }}
    style={{ width: 440, maxWidth: 'calc(100vw - 48px)', borderRadius: 12, border: `1px solid ${border}`, padding: 24,
      background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'var(--dsw-alias-label-primary, #1a2744)' }}>
    <form onSubmit={(e) => { void submit(e) }}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      {user && <p style={{ fontSize: 13, color: secondary }}>{user.displayName} · {user.email}</p>}
      {(dialog.kind === 'create' || dialog.kind === 'edit') && <>
        <label style={field}>姓名<TextInput required maxLength={128} value={displayName} onChange={(e) => setName(e.target.value)} disabled={busy} autoFocus /></label>
        <label style={field}>登录邮箱<TextInput required type="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} /></label>
        <label style={field}>角色<Select aria-label="角色" value={role} onChange={(e) => setRole(e.target.value as UserRole)} disabled={busy || user?.id === selfId}>
          {Object.entries(USER_ROLES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></label>
      </>}
      {(dialog.kind === 'create' || dialog.kind === 'password') && <>
        <label style={field}>{dialog.kind === 'create' ? '初始密码' : '新密码'}<TextInput required type="password" autoComplete="new-password" minLength={10} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} /></label>
        <label style={field}>确认密码<TextInput required type="password" autoComplete="new-password" minLength={10} maxLength={128} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} disabled={busy} /></label>
        <p style={{ fontSize: 12, color: secondary }}>密码须为 10–128 个字符，请通过安全方式告知本人。</p>
      </>}
      {dialog.kind === 'status' && <p style={{ fontSize: 13 }}>{user?.status === 'active' ? '停用后将退出所有旧登录会话，并停止当前运行时。已有会话记录和工作区会保留。' : '启用后，成员可使用现有密码重新登录。'}</p>}
      {dialog.kind === 'delete' && <p style={{ fontSize: 13, lineHeight: 1.7 }}>确认删除该人员？删除后将从人员列表移除，禁止登录并退出旧会话，正在运行的任务会停止。历史工作区、会话和审计记录会保留。此操作无法在页面恢复，原邮箱仍保留占用。</p>}
      {(dialog.kind === 'edit' || dialog.kind === 'password') && <p style={{ fontSize: 12, color: secondary }}>修改邮箱、角色或密码后，该成员需要重新登录，正在运行的任务会停止。</p>}
      {error && <p role="alert" style={{ color: 'var(--dsw-alias-label-danger, #d93025)', fontSize: 13 }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'end', marginTop: 20 }}>
        <button type="button" style={buttonStyle('ghost')} disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" style={{ ...buttonStyle(), ...(dialog.kind === 'delete' ? { background: 'var(--dsw-alias-label-danger, #d93025)' } : {}) }} disabled={busy}>{busy ? '处理中…' : dialog.kind === 'delete' ? '确认删除' : '确认'}</button>
      </div>
    </form>
  </dialog>
}

const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, marginBottom: 14 }
