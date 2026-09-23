import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * 0.1.1 → 0.1.5 agent-preset upgrade compatibility.
 *
 * DSH 0.1.5 renamed the shipped agent preset `code` → `ptc`; the Session V2→V3
 * migration rewrites historical sessions, but a user's `settings.yaml`
 * (`agent-presets.default: code`) is NOT covered. A stale default makes every
 * new Session fail with `agent-preset/not-found`.
 *
 * This migration runs BEFORE the 0.1.5 Runtime spawns. It is:
 *   - idempotent (default already `ptc` → NOOP),
 *   - atomic (temp file + rename),
 *   - structure-preserving (only the exact `agent-presets.default` scalar is
 *     rewritten; every other line/field/comment is kept byte-for-byte),
 *   - exact-rename only (`code` → `ptc`); an unknown custom default is never
 *     rewritten to `standard`/`ptc`.
 *
 * It is deliberately a line-scoped scalar editor, not a YAML parser/serializer,
 * so it cannot drop unrelated settings. A form it does not recognize is a NOOP.
 */

/** The shipped preset roster of the pinned DSH (`@deepseek-ai/dsh-agent-presets/presets`). */
export const TARGET_AGENT_PRESETS: ReadonlySet<string> = new Set(['cordis', 'minimal', 'ptc', 'standard'])

/** The only preset rename this migration is allowed to perform. */
const KNOWN_RENAME: Readonly<Record<string, string>> = { code: 'ptc' }

export interface AgentPresetRewrite {
  status: 'migrated' | 'noop'
  text: string
  from?: string
  to?: string
  reason: string
}

function noop(text: string, reason: string): AgentPresetRewrite {
  return { status: 'noop', text, reason }
}

/** Parse the scalar after `default:`; returns the unquoted value and a rewriter. */
function parseDefaultScalar(raw: string): { value: string; rewrite: (next: string) => string } | null {
  const leading = /^\s*/.exec(raw)?.[0] ?? ''
  let rest = raw.slice(leading.length)
  let quote = ''
  if (rest.startsWith('"') || rest.startsWith("'")) {
    quote = rest[0] as string
    const end = rest.indexOf(quote, 1)
    if (end === -1) return null
    const value = rest.slice(1, end)
    const tail = rest.slice(end + 1)
    return { value, rewrite: (next) => `${leading}${quote}${next}${quote}${tail}` }
  }
  // Unquoted: token ends at whitespace or a comment marker.
  const match = /^([^\s#]+)([\s\S]*)$/.exec(rest)
  if (match === null) return null
  const value = match[1] as string
  const tail = match[2] as string
  return { value, rewrite: (next) => `${leading}${next}${tail}` }
}

/**
 * Rewrite an exact `agent-presets.default: code` to `ptc` in a settings document.
 * @param text - settings YAML/JSON text.
 * @param roster - the target runtime's shipped preset ids.
 */
export function rewriteAgentPresetDefault(text: string, roster: ReadonlySet<string> = TARGET_AGENT_PRESETS): AgentPresetRewrite {
  if (!roster.has('ptc') || roster.has('code')) return noop(text, 'roster-incompatible')

  // Keep line endings: even indices are content, odd indices are separators.
  const lines = text.split(/(\r?\n)/)
  let apIndex = -1
  for (let i = 0; i < lines.length; i += 2) {
    if (/^agent-presets:\s*(?:#.*)?$/.test(lines[i] ?? '')) { apIndex = i; break }
  }
  if (apIndex === -1) return noop(text, 'no-agent-presets')

  for (let i = apIndex + 2; i < lines.length; i += 2) {
    const line = lines[i] ?? ''
    if (line.trim() === '') continue
    if (!/^\s/.test(line)) break // next top-level key: block ended
    const match = /^(\s+)default:([\s\S]*)$/.exec(line)
    if (match === null) continue
    const parsed = parseDefaultScalar(match[2] as string)
    if (parsed === null) return noop(text, 'unrecognized-default-scalar')
    if (parsed.value !== 'code') return noop(text, 'default-not-code')
    const next = KNOWN_RENAME['code'] as string
    lines[i] = `${match[1]}default:${parsed.rewrite(next)}`
    return { status: 'migrated', text: lines.join(''), from: 'code', to: next, reason: 'ok' }
  }
  return noop(text, 'no-default-key')
}

export interface AgentPresetMigrationResult {
  status: 'migrated' | 'noop' | 'error'
  from?: string
  to?: string
  reason: string
}

/**
 * Migrate the per-user settings document (`<homeDir>/settings.yaml`) before the
 * 0.1.5 Runtime spawns. Missing document → NOOP. Never throws for a stale/odd
 * document; returns `error` so the caller can log without blocking startup.
 */
export async function migrateAgentPresetSetting(homeDir: string): Promise<AgentPresetMigrationResult> {
  const file = path.join(homeDir, 'settings.yaml')
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return { status: 'noop', reason: 'no-settings-file' }
  }
  const rewrite = rewriteAgentPresetDefault(text)
  if (rewrite.status !== 'migrated') return { status: 'noop', reason: rewrite.reason }
  try {
    await mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, rewrite.text, 'utf8')
    await rename(tmp, file)
    return { status: 'migrated', from: rewrite.from, to: rewrite.to, reason: 'ok' }
  } catch (err) {
    return { status: 'error', reason: String(err) }
  }
}
