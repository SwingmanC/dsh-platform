/**
 * ui-platform-account —— dsh Client 半区(真实 source of truth)。
 *
 * 在侧边栏底部(`sidebar.footer.action`)注册平台账号条目 + 退出登录。
 * 契约来源:docs/implementation/REWORK-02C-client-contract.md。
 *
 * 纪律:React 组件不接收 Cordis ctx;无 DOM querySelector 读取;账号名经
 * `/auth/me` 获取;退出登录走 `/auth/logout`(CSRF header)。
 */
import * as React from 'react'

export const name = 'ui-platform-account'

export const inject = ['slots'] as const

interface SlotsService {
  inject(slot: string, cb: () => (() => void) | void): void
  register(
    options: { name: string; id?: string; order?: number; label?: string },
    component: (props: Record<string, unknown>) => React.ReactNode,
  ): () => void
}

interface ClientContext {
  slots: SlotsService
}

interface MeResponse {
  userId?: string
  displayName?: string
}

/** 读取非 HttpOnly cookie(CSRF token)。 */
function readCookie(name: string): string {
  const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'))
  return match?.[1] ? decodeURIComponent(match[1]) : ''
}

const styles = {
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '6px 10px',
    margin: '4px 8px',
    borderRadius: 6,
    background: 'rgba(26,109,255,0.08)',
    fontSize: 13,
  },
  name: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#1a2744' },
  btn: {
    flexShrink: 0,
    background: '#1a6dff',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '3px 10px',
    fontSize: 12,
    cursor: 'pointer',
  },
} as const

function PlatformAccountButton(): React.ReactElement {
  const [displayName, setDisplayName] = React.useState('用户')
  React.useEffect(() => {
    let alive = true
    fetch('/auth/me', { credentials: 'include' })
      .then((res) => (res.ok ? (res.json() as Promise<MeResponse>) : null))
      .then((data) => {
        if (alive && data) setDisplayName(data.displayName || data.userId || '用户')
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const logout = React.useCallback(() => {
    fetch('/auth/logout', {
      method: 'POST',
      headers: { 'x-csrf-token': readCookie('csrf_token') },
      credentials: 'include',
      redirect: 'manual',
    })
      .catch(() => undefined)
      .finally(() => {
        // 退出登录后的整页导航(非 SPA 导航,无第二套路由)。
        window.location.assign('/login')
      })
  }, [])

  return (
    <div style={styles.row}>
      <span style={styles.name} title={displayName}>
        {displayName}
      </span>
      <button type="button" style={styles.btn} onClick={logout}>
        退出
      </button>
    </div>
  )
}

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'platform-account', order: 100 },
      PlatformAccountButton as unknown as (props: Record<string, unknown>) => React.ReactNode,
    ),
  )
}
