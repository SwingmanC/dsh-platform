import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'

export interface UsagePayload {
  sessionId: string; eventSeq: number; occurredAt: string; provider: string; model: string
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number
}

const RETRY_MS = 15_000
const REQUEST_TIMEOUT_MS = 5_000
const MAX_BATCH = 100
const MAX_FILE_BYTES = 64 * 1024
const STALE_TEMP_MS = 60_000

export class UsageSpool {
  private flushing = false
  private timer: NodeJS.Timeout | null = null
  private lastWarning = ''
  private lastWarningAt = 0

  constructor(
    private readonly dir: string,
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly log: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
  ) {}

  start(): void {
    if (this.timer !== null) return
    void this.flush()
    this.timer = setInterval(() => { void this.flush() }, RETRY_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /** 先持久化再尝试发送；成功确认之前绝不删除本地事件。 */
  async enqueue(payload: UsagePayload): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const key = createHash('sha256').update(`${payload.sessionId}:${payload.eventSeq}`).digest('hex')
    const target = path.join(this.dir, `${key}.json`)
    const temporary = path.join(this.dir, `${key}.${randomUUID()}.tmp`)
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(payload), 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, target)
    await this.flush()
  }

  async flush(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 })
      const names = (await readdir(this.dir)).filter((name) => /^[a-f0-9]{64}(?:\.[a-f0-9-]+)?\.(?:json|tmp)$/.test(name)).sort()
      if (names.length >= 1_000) this.warn(`待上报事件积压 ${names.length} 条，请检查网关或 Runtime token`)
      if (this.url === '' || this.token === '') {
        if (names.length > 0) this.warn(`内部上报通道未配置，${names.length} 条事件仍在本地队列`)
        return
      }
      for (const name of names.slice(0, MAX_BATCH)) {
        const filePath = path.join(this.dir, name)
        if (name.endsWith('.tmp')) {
          // 其他 Runtime 可能仍在写临时文件；只恢复已中断的旧临时文件。
          const info = await stat(filePath).catch(() => null)
          if (info === null || Date.now() - info.mtimeMs < STALE_TEMP_MS) continue
        }
        let payload: UsagePayload
        try {
          const info = await stat(filePath)
          if (info.size > MAX_FILE_BYTES) throw new Error('oversized spool file')
          payload = JSON.parse(await readFile(filePath, 'utf8')) as UsagePayload
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          await rename(filePath, `${filePath}.corrupt`).catch(() => {})
          this.warn(`待上报文件无法读取，已隔离待排查：${name} (${error instanceof Error ? error.message : 'unknown'})`)
          continue
        }
        try {
          const response = await this.fetchImpl(`${this.url}/internal/usage/events`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-runtime-token': this.token },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          })
          if (!response.ok) {
            if (response.status === 400 || response.status === 422) {
              await rename(filePath, `${filePath}.rejected`)
              this.warn(`事件被网关拒绝，已保留为待排查文件：${name} (HTTP ${response.status})`)
              continue
            }
            this.warn(`上报失败，事件仍在本地队列：HTTP ${response.status}`)
            break
          }
          await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
          })
        } catch (error) {
          this.warn(`上报失败，事件仍在本地队列：${error instanceof Error ? error.name : 'network-error'}`)
          break
        }
      }
    } catch (error) {
      this.warn(`用量待上报队列不可用：${error instanceof Error ? error.message : 'unknown'}`)
    } finally {
      this.flushing = false
    }
  }

  private warn(message: string): void {
    const now = Date.now()
    if (message !== this.lastWarning || now - this.lastWarningAt >= 60_000) {
      this.log(`[cmcc-usage-reporter] ${message}`)
      this.lastWarning = message
      this.lastWarningAt = now
    }
  }
}
