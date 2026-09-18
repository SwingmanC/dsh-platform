import { useEffect, useState } from 'react'

/** 极简 hash 路由:无需服务端配置,Vite dev 与生产静态托管均可用。 */
export function useHashRoute(): { path: string; navigate: (path: string) => void } {
  const [path, setPath] = useState<string>(() => normalize(window.location.hash))

  useEffect(() => {
    const onHash = (): void => setPath(normalize(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const navigate = (next: string): void => {
    if (normalize(window.location.hash) === next) return
    window.location.hash = next
  }

  return { path, navigate }
}

function normalize(hash: string): string {
  const raw = hash.replace(/^#/, '')
  return raw === '' ? '/' : raw
}
