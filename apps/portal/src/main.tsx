import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

/**
 * 平台首页骨架(platform 设计 §1 流程 A/B):
 * 登录门 → 历史会话/工作区 → /app 反代进入 dsh 实例。
 * 会话列表、enter 前工作区校验与 S1/S2 迁移弹窗随 T4 落地;
 * 本文件先建立「登录页默认呈现 + 后端连通显示」的可运行起点。
 */

interface WorkspaceRow {
  id: string
  userId: string
  canonicalPath: string
  displayName: string
  lastUsedAt: string | null
  missingSince: string | null
}

function App() {
  const [health, setHealth] = useState('检查网关…')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((d: { db?: boolean }) =>
        setHealth(d.db ? '网关与 MySQL 在线' : '网关在线,MySQL 不可达'),
      )
      .catch(() => setHealth('网关不可达(pnpm dev:gateway)'))
  }, [])

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoginError(null)
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (res.status === 501) {
      setLoginError('登录后端随 T1 实现(当前为骨架)')
      return
    }
    if (!res.ok) setLoginError('邮箱或密码错误')
    else window.location.href = '/'
  }

  const [workspaces] = useState<WorkspaceRow[]>([])

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 420, margin: '12vh auto' }}>
      <h1>dsh platform</h1>
      <p style={{ color: '#666', fontSize: 14 }}>{health}</p>
      <form onSubmit={handleLogin}>
        <input
          type="email"
          placeholder="邮箱"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ width: '100%', padding: 8, marginBottom: 8, boxSizing: 'border-box' }}
          required
        />
        <input
          type="password"
          placeholder="密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ width: '100%', padding: 8, marginBottom: 8, boxSizing: 'border-box' }}
          required
        />
        <button type="submit" style={{ width: '100%', padding: 8 }}>
          登录
        </button>
      </form>
      {loginError !== null && <p style={{ color: '#c0392b', fontSize: 14 }}>{loginError}</p>}
      <p style={{ color: '#999', fontSize: 12 }}>
        登录后此处展示历史工作区(当前 {workspaces.length} 条,随 T4 接入 /api/workspaces)。
      </p>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
