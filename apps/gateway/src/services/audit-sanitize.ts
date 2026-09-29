/** Only business metadata is allowed; bodies, errors, paths and credentials are excluded. */
const ALLOWED = new Set(['role', 'status', 'changedFields', 'runtimeStopped', 'visibility', 'fromVisibility',
  'toVisibility', 'transport', 'scope', 'riskLevel', 'configured', 'locked', 'reason', 'userId', 'ip',
  'fileSize', 'contentType', 'chunkCount', 'code', 'signal', 'syncStatus', 'kind', 'extractionMode', 'truncated'])
const SENSITIVE = /apikey|password|passwd|secret|token|authorization|credential|masterkey|privatekey|content|prompt|body|cookie/i

function clean(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > 5) return '[TRUNCATED]'
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return value.slice(0, 256)
  if (typeof value !== 'object') return null
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  if (Array.isArray(value)) return value.slice(0, 30).map((v) => clean(v, depth + 1, seen))
  const result: Record<string, unknown> = Object.create(null)
  for (const [key, v] of Object.entries(value).slice(0, 30)) {
    const normalized = key.toLowerCase().replace(/[_-]/g, '')
    result[key.slice(0, 64)] = SENSITIVE.test(normalized) ? '[REDACTED]' : clean(v, depth + 1, seen)
  }
  return result
}

export function sanitizePayload(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const out: Record<string, unknown> = Object.create(null)
  const seen = new WeakSet<object>()
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED.has(key)) continue
    out[key] = clean(value, 0, seen)
  }
  // Preserve valid JSON when enforcing the byte limit.
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') > 4096) return { truncated: true }
  return Object.keys(out).length ? out : null
}
