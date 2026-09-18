/**
 * Panel 通用 hooks:异步资源加载 + mutation 状态。
 *
 * 加载状态机在 models/resource.ts(纯函数,可测);这里只负责 React 绑定。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ResourceState } from '../models/resource.js'
import { errorMessage } from '../models/resource.js'

export interface AsyncState<T> {
  state: ResourceState<T>
  reload: () => void
  setState: (next: ResourceState<T>) => void
}

export function useAsyncState<T>(loader: () => Promise<ResourceState<T>>, deps: readonly unknown[]): AsyncState<T> {
  const [state, setState] = useState<ResourceState<T>>({ status: 'loading' })
  const [nonce, setNonce] = useState(0)
  const loaderRef = useRef(loader)
  loaderRef.current = loader

  useEffect(() => {
    let alive = true
    setState({ status: 'loading' })
    loaderRef.current().then((next) => {
      if (alive) setState(next)
    })
    return () => {
      alive = false
    }
    // deps 由调用方决定;nonce 触发 reload。
  }, [...deps, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { state, reload, setState }
}

export interface MutationState {
  pending: boolean
  error: string | null
  run: <R>(fn: () => Promise<R>, onSuccess?: (result: R) => void) => void
}

/** mutation:进入 pending → 真实 API → 成功回调(通常用 reload 重读)→ 失败可见。 */
export function useMutation(): MutationState {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)
  useEffect(() => () => {
    aliveRef.current = false
  }, [])

  const run = useCallback(<R,>(fn: () => Promise<R>, onSuccess?: (result: R) => void) => {
    setPending(true)
    setError(null)
    fn()
      .then((result) => {
        if (!aliveRef.current) return
        setPending(false)
        onSuccess?.(result)
      })
      .catch((err: unknown) => {
        if (!aliveRef.current) return
        setPending(false)
        setError(errorMessage(err))
      })
  }, [])

  return { pending, error, run }
}
