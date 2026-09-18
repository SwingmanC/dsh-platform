/**
 * Phase 07 Memory E2E harness.
 *
 * 真实链路:Gateway(真实 MySQL) → supervisor spawn 真实 dsh 0.1.5 Runtime
 *   → cmcc-memory-runtime(memory tools + bounded recall + 显式提取)
 *   → internal mutation channel → DB → projection。
 *
 * 覆盖:cross-session recall / restart persistence / forget / A/B isolation。
 *
 * 用法:node scripts/memory-e2e.mjs
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const dshBin = path.join(repoRoot, '.tools', 'dsh-0.1.5-rc.2', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const runner = path.join(repoRoot, 'scripts', 'dsh-runner.mjs')
const gatewayEntry = path.join(repoRoot, 'apps', 'gateway', 'dist', 'index.js')

// Load MySQL settings from repo .env.
const envText = await readFile(path.join(repoRoot, '.env'), 'utf8').catch(() => '')
const mysql = {}
for (const line of envText.split(/\r?\n/)) {
  const m = /^(MYSQL_[A-Z_]+)=(.*)$/.exec(line)
  if (m) mysql[m[1]] = m[2]
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

function spawnGateway(runId, user) {
  const base = path.join(repoRoot, 'var', 'e2e-memory', runId)
  const probeOut = path.join(base, 'probe.json')
  const port = user.port
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(port),
    HOST: '127.0.0.1',
    MYSQL_HOST: mysql.MYSQL_HOST ?? '127.0.0.1',
    MYSQL_PORT: mysql.MYSQL_PORT ?? '3306',
    MYSQL_USER: mysql.MYSQL_USER ?? 'root',
    MYSQL_PASSWORD: mysql.MYSQL_PASSWORD ?? '',
    MYSQL_DATABASE: mysql.MYSQL_DATABASE ?? 'dsh_platform',
    SESSION_SECRET: 'e2e-session-secret-0123456789abcdef',
    PLATFORM_SECRET_ENCRYPTION_KEY: 'a'.repeat(64),
    PLATFORM_AUTHORITY: 'localhost:5173',
    PLATFORM_SCHEME: 'http',
    PLATFORM_DSH_UI_AUTHORITY: `localhost:${port}`,
    PLATFORM_GATEWAY_ORIGIN: 'http://localhost:5173',
    PLATFORM_DSH_NODE_BIN: process.execPath,
    PLATFORM_DSH_CLI_ENTRY: runner,
    E2E_DSH_BIN: dshBin,
    PLATFORM_DSH_VERSION: '0.1.5-rc.2',
    PLATFORM_DSH_HOMES_ROOT: path.join(base, 'homes'),
    PLATFORM_DSH_WORKSPACES_ROOT: path.join(base, 'workspaces'),
    PLATFORM_DSH_PROJECTIONS_ROOT: path.join(base, 'projections'),
    PLATFORM_KNOWLEDGE_STORAGE_ROOT: path.join(base, 'kb-storage'),
    PLATFORM_KNOWLEDGE_PROJECTIONS_ROOT: path.join(base, 'projections'),
    PLATFORM_MCP_PROJECTIONS_ROOT: path.join(base, 'projections'),
    PLATFORM_MEMORY_PROJECTIONS_ROOT: path.join(base, 'projections'),
    PLATFORM_DSH_IDLE_TTL_MS: '900000',
    PLATFORM_E2E_MEMORY_PROBE: '1',
    E2E_MEMORY_PROBE_OUT: probeOut,
    E2E_MEMORY_PROBE_MARKER: user.marker,
    E2E_MEMORY_PROBE_FOREIGN: user.foreign,
    E2E_MEMORY_PROBE_SESSION: `${runId}-s1`,
    E2E_MEMORY_PROBE_DELAY: '7000',
    E2E_MEMORY_PROBE_FORGET: user.forget ? '1' : '0',
  }
  const child = spawn(process.execPath, [gatewayEntry], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let log = ''
  child.stdout.on('data', (c) => { log += c.toString() })
  child.stderr.on('data', (c) => { log += c.toString() })
  return { child, base, probeOut, port, getLog: () => log }
}

async function waitHealth(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (res.ok) return true
    } catch { /* not ready */ }
    await delay(500)
  }
  return false
}

function parseCookies(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  const jar = {}
  for (const c of raw) {
    const [pair] = c.split(';')
    const idx = pair.indexOf('=')
    if (idx > 0) jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim()
  }
  return jar
}

async function login(port, email, password) {
  const res = await fetch(`http://127.0.0.1:${port}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  return parseCookies(res)
}

async function ensureRuntime(port, jar) {
  const cookie = `sid=${jar.sid}; csrf_token=${jar.csrf_token}`
  const res = await fetch(`http://127.0.0.1:${port}/api/runtimes/ensure`, {
    method: 'POST', headers: { cookie, 'x-csrf-token': jar.csrf_token },
  })
  if (!res.ok) throw new Error(`ensure failed: ${res.status} ${await res.text()}`)
  return res.json()
}

async function readProbe(file) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return null }
}

async function waitProbe(file, predicate, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const data = await readProbe(file)
    if (data !== null && predicate(data)) return data
    await delay(1000)
  }
  return null
}

function killDshForRun(runId) {
  try {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${runId}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], { stdio: 'ignore' })
  } catch { /* best effort */ }
}

async function apiMemory(port, jar, q) {
  const cookie = `sid=${jar.sid}; csrf_token=${jar.csrf_token}`
  const res = await fetch(`http://127.0.0.1:${port}/api/memory?q=${encodeURIComponent(q)}&limit=50`, { headers: { cookie } })
  if (!res.ok) return { records: [], total: 0 }
  return res.json()
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  process.stdout.write(`[e2e] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`)
}

async function runUser(runId, user) {
  const gw = spawnGateway(runId, user)
  let jar
  try {
    if (!(await waitHealth(gw.port))) throw new Error('gateway health timeout')
    jar = await login(gw.port, user.email, user.password)
    await ensureRuntime(gw.port, jar)

    // 1. cross-session recall + tools + extraction
    const probe = await waitProbe(gw.probeOut, (d) => d.remember !== undefined && d.search !== undefined && (d.recallContexts !== undefined || d.recallError !== undefined))
    if (probe === null) {
      check(`${runId}: probe completed`, false)
      process.stdout.write(`--- gateway log (${runId}) ---\n${gw.getLog()}\n--- end ---\n`)
      return
    }

    const rememberOk = probe.remember?.value?.ok === true
    check(`${runId}: memory_remember PASS`, rememberOk)
    const searchHit = (probe.search?.value?.results ?? []).some((r) => typeof r.snippet === 'string' && r.snippet.includes(user.marker))
    check(`${runId}: memory_search finds marker`, searchHit)
    const recallText = (probe.recallContexts ?? []).join('\n')
    check(`${runId}: bounded recall injection contains marker + framing`,
      recallText.includes('<cmcc-memory-recall>') && recallText.includes(user.marker),
      probe.recallError ? String(probe.recallError) : '')
    const foreign = probe.foreignSearch?.value?.results ?? []
    check(`${runId}: foreign marker not visible`, foreign.length === 0)
    check(`${runId}: secret-like content rejected by memory_remember`, probe.secretRemember?.value?.ok === false)
    check(`${runId}: aborted turn does not extract`, (probe.abortedSearch?.value?.results ?? []).length === 0)

    // 2. platform DB has marker (authoritative), not foreign
    const platformMem = await apiMemory(gw.port, jar, user.marker)
    check(`${runId}: platform DB has marker`, (platformMem.records ?? []).some((r) => r.content.includes(user.marker)))
    if (user.foreign) {
      const foreignMem = await apiMemory(gw.port, jar, user.foreign)
      check(`${runId}: platform DB lacks foreign marker`, (foreignMem.records ?? []).length === 0)
    }

    // 3. restart persistence
    const before = await stat(gw.probeOut).then((s) => s.mtimeMs).catch(() => 0)
    killDshForRun(runId)
    await delay(2000)
    await ensureRuntime(gw.port, jar)
    let restarted = null
    const restartDeadline = Date.now() + 90000
    while (Date.now() < restartDeadline) {
      const m = await stat(gw.probeOut).then((s) => s.mtimeMs).catch(() => 0)
      const d = await readProbe(gw.probeOut)
      if (m > before && d !== null && d.search !== undefined) { restarted = d; break }
      await delay(1000)
    }
    check(`${runId}: restart persistence (fresh runtime recalls marker)`,
      restarted !== null && (restarted.search?.value?.results ?? []).some((r) => typeof r.snippet === 'string' && r.snippet.includes(user.marker)))

    // 4. forget
    if (user.forget) {
      const forgot = await waitProbe(gw.probeOut, (d) => d.afterForget !== undefined, 60000)
      check(`${runId}: memory_forget removes from runtime`,
        (forgot?.afterForget?.value?.results ?? []).length === 0)
    }
  } catch (err) {
    check(`${runId}: run`, false, String(err))
  } finally {
    gw.child.kill()
    await delay(1000)
    killDshForRun(runId)
  }
}

// A: admin (default tenant), marker A; B: userb (tenant-b), marker B. forget on B only.
const nonce = Date.now().toString(36)
const markerA = `A_ONLY_MEMORY_07_${nonce}`
const markerB = `B_ONLY_MEMORY_07_${nonce}`
await runUser('run-a', {
  port: 8099, email: 'admin@local.dev', password: 'Admin@12345',
  marker: markerA, foreign: markerB, forget: false,
})
await runUser('run-b', {
  port: 8098, email: 'userb@local.dev', password: 'Admin@12345',
  marker: markerB, foreign: markerA, forget: true,
})

const failed = results.filter((r) => !r.ok)
process.stdout.write(`\n[e2e] ${results.length - failed.length}/${results.length} checks passed\n`)
process.exit(failed.length === 0 ? 0 : 1)
