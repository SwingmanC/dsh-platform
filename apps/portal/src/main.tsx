import { StrictMode, useState, useEffect } from 'react'
import type { FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { login, getMe } from './api.js'
import { BrandMark } from './components/BrandMark.js'
import './styles/tokens.css'

/** Portal 只负责登录；登录页不能留在进入 DSH 后的浏览器历史中。 */
const DSH_UI_URL: string = import.meta.env.VITE_DSH_UI_URL ?? 'http://localhost:8080/'

function LoginView(): JSX.Element {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault(); setError(null); setBusy(true)
    try {
      await login(email, password)
      // 平台会话已建立(sid cookie 跨 authority 共享);整页跳转到 dsh UI,
      // 由网关按 Host 反代到该用户的运行时实例。
      window.location.replace(DSH_UI_URL)
    } catch (err) {
      const code = (err as Error).message
      setError(
        code === 'invalid-credentials' ? '邮箱或密码错误'
        : code === 'account-disabled' ? '账号已被停用'
        : code === 'locked' ? '尝试次数过多，请稍后再试'
        : '登录失败，请稍后重试',
      )
    } finally { setBusy(false) }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', background: 'var(--cmcc-bg)' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '60px', background: 'linear-gradient(135deg, #0a1628 0%, #1a2744 50%, #0085D0 100%)', color: '#fff' }}>
        <BrandMark size={56} />
        <h1 style={{ fontSize: '32px', fontWeight: 600, marginTop: '24px', letterSpacing: '2px' }}>中国移动数智智能体平台</h1>
        <p style={{ fontSize: '16px', marginTop: '12px', opacity: 0.85, maxWidth: '400px', lineHeight: 1.6 }}>
          面向研发、运营与企业协同的智能体工作平台
        </p>
        <p style={{ fontSize: '14px', marginTop: '32px', opacity: 0.6 }}>连接能力 · 协同智能 · 安全可控</p>
      </div>
      <div style={{ width: '440px', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px' }}>
        <div style={{ width: '100%', maxWidth: '360px' }}>
          <h2 style={{ fontSize: '22px', fontWeight: 600, color: 'var(--cmcc-text)', marginBottom: '32px' }}>账号登录</h2>
          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: '20px' }}>
              <label style={labelStyle}>邮箱</label>
              <input type="email" placeholder="请输入邮箱地址" value={email}
                onChange={(e) => setEmail(e.target.value)} style={inputStyle} required />
            </div>
            <div style={{ marginBottom: '20px' }}>
              <label style={labelStyle}>密码</label>
              <input type="password" placeholder="请输入密码" value={password}
                onChange={(e) => setPassword(e.target.value)} style={inputStyle} required />
            </div>
            {error && <p style={{ color: 'var(--cmcc-danger)', fontSize: '13px', padding: '10px 14px', background: '#fef2f2', borderRadius: 'var(--radius-md)', marginBottom: '16px' }}>{error}</p>}
            <button type="submit" disabled={busy} style={{
              width: '100%', padding: '12px', fontSize: '16px', fontWeight: 500,
              background: 'var(--cmcc-primary)', color: '#fff', border: 'none',
              borderRadius: 'var(--radius-md)', letterSpacing: '4px', opacity: busy ? 0.6 : 1,
            }}>{busy ? '登录中...' : '登 录'}</button>
          </form>
          <p style={{ textAlign: 'center', fontSize: '12px', color: 'var(--cmcc-text-secondary)', marginTop: '32px' }}>
            仅限授权用户访问 | © 中国移动
          </p>
        </div>
      </div>
    </div>
  )
}

function App(): JSX.Element {
  const [status, setStatus] = useState<'checking' | 'guest' | 'redirecting'>('checking')

  useEffect(() => {
    let active = true
    getMe()
      .then((u) => {
        if (!active) return
        if (u !== null) {
          setStatus('redirecting')
          window.location.replace(DSH_UI_URL)
        } else {
          setStatus('guest')
        }
      })
      .catch(() => { if (active) setStatus('guest') })
    return () => { active = false }
  }, [])

  if (status === 'guest') return <LoginView />
  return <div style={{ padding: '80px', textAlign: 'center', color: 'var(--cmcc-text-secondary)' }}>加载中...</div>
}

const labelStyle: React.CSSProperties = { display: 'block', fontSize: '14px', fontWeight: 500, color: 'var(--cmcc-text)', marginBottom: '6px' }
const inputStyle: React.CSSProperties = { width: '100%', padding: '10px 14px', fontSize: '15px', border: '1px solid var(--cmcc-border)', borderRadius: 'var(--radius-md)', outline: 'none', background: 'var(--cmcc-surface)' }

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
)
