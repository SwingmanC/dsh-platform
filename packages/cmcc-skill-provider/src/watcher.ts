/**
 * 投影目录 watcher:catalog.json 变化 → debounce → control.invalidate()。
 *
 * 要求:dispose/abort 时关闭;重复事件幂等;atomic rename 下部分写入不可见。
 */
import { watch } from 'node:fs'
import path from 'node:path'

export interface ProjectionWatcher {
  close: () => void
}

/**
 * 监听投影目录(过滤 catalog.json)。变化后延迟 debounceMs 触发一次 onInvalidate。
 * @param dir - 投影 skills 目录。
 * @param signal - provider 注册生命周期 signal;abort 时自动关闭。
 * @param onInvalidate - 幂等的失效回调(通常为 control.invalidate)。
 */
export function watchCatalog(dir: string, signal: AbortSignal, onInvalidate: () => void, debounceMs = 200): ProjectionWatcher {
  let timer: NodeJS.Timeout | null = null
  let closed = false
  let watcher: ReturnType<typeof watch> | null = null

  const fire = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (!closed) onInvalidate()
    }, debounceMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  try {
    watcher = watch(dir, { persistent: false }, (_event, filename) => {
      if (filename === null || filename === 'catalog.json') fire()
    })
    watcher.on('error', () => { /* 忽略 watcher 错误,不 crash Runtime */ })
  } catch {
    watcher = null
  }

  const close = (): void => {
    if (closed) return
    closed = true
    if (timer !== null) { clearTimeout(timer); timer = null }
    watcher?.close()
    watcher = null
  }

  signal.addEventListener('abort', close, { once: true })
  return { close }
}
