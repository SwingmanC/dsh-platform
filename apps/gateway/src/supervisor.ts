import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import type { AuthenticatedPrincipal } from '@dsh-platform/shared'
import { config } from './config.js'
import { execute } from './db.js'
import { deployPlatformPatch } from './profile-patch.js'
import { buildSkillProjection, skillProjectionDir } from './skill-projection.js'
import { knowledgeService } from './services/knowledge-service.js'
import { knowledgeProjectionDir } from './knowledge-projection.js'
import { buildMcpProjection, readMcpProjection, renderMcpPatchEntries, mcpProjectionDir } from './mcp-projection.js'
import type { McpPatchEntry, ProjectedServer } from './mcp-projection.js'
import { mcpRepository } from './repositories/mcp-repository.js'
import { getCredentialStore } from './credentials/credential-store.js'
import { memoryService } from './services/memory-service.js'
import { memoryProjectionDir } from './memory-projection.js'
import { issueRuntimeToken, revokeRuntimeToken } from './internal-channel.js'
import { ensureDefaultWorkspace } from './platform.js'
import { migrateAgentPresetSetting } from './agent-preset-migration.js'

export type RuntimeState = 'starting' | 'ready' | 'draining' | 'dead'

/** 每用户 dsh 实例的运行时信息(总方案 §5/§8)。 */
export interface RuntimeInfo {
  runtimeId: string
  userId: string
  tenantId: string
  state: RuntimeState
  homeDir: string
  workspaceRoot: string
  /** 上游基址:真实实例为 http://127.0.0.1:<port>;mock 模式为固定上游。 */
  upstreamUrl: string
  port: number | null
  pid: number | null
  /** 实例声明的 authority(--trusted-host,与代理注入的 Host 配对)。 */
  authority: string
  /**
   * dsh 0.1.5+ 的进程级 launch token(仅内存)。
   * 只用于 Gateway→DSH 的 `GET /?token=...` 一次性 cookie 交换:
   * 绝不写 MySQL / audit / 浏览器 API / 日志;进程退出即清空。
   * 0.1.1 无 token 时为 null。
   */
  launchToken: string | null
  /** 该 runtime 的 bootstrap 串行锁(避免并发消费一次性 token)。 */
  bootstrapInFlight: Promise<void> | null
  /**
   * 最近一次完成 launch-token bootstrap 的平台会话 id。
   * dsh 浏览器 cookie 按 authority 命名(不含用户),同一浏览器切换账号时会串;
   * 因此以平台 session 为准决定是否需要重新 bootstrap。
   */
  lastBootstrappedSid: string | null
  startedAt: number
  lastHeartbeat: number
  /** 最近一次被请求的时间(空闲回收依据)。 */
  lastActivity: number
}

/** 日志脱敏:`?token=<value>` → `?token=[REDACTED]`。 */
export function redactToken(text: string): string {
  return text.replace(/([?&]token=)[^\s&"'\\)\]]+/gi, '$1[REDACTED]')
}

export interface RuntimeUser {
  userId: string
  tenantId: string
  displayName: string
}

const registry = new Map<string, RuntimeInfo>()
const inflight = new Map<string, Promise<RuntimeInfo>>()
const children = new Map<string, ChildProcess>()

/** 仅测试/排障用。 */
export function getRuntime(userId: string): RuntimeInfo | undefined {
  return registry.get(userId)
}

export function listRuntimes(): RuntimeInfo[] {
  return [...registry.values()]
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/**
 * 构造交给 dsh 子进程的环境:剔除平台自有变量。
 * dsh 把 `DSH_` 前缀视为保留(见 @deepseek-ai/dsh-app-boot 的 BOOTSTRAP_PREFIXES),
 * 且不应看到网关的 MySQL/会话凭据。仅注入实例运行所需项。
 */
function childEnv(homeDir: string, workspaceRoot: string, user: RuntimeUser, mcpSecrets: Record<string, string> = {}, memoryToken = '', defaultWorkspace: { path: string; title: string } | null = null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('DSH_') ||
      key.startsWith('PLATFORM_') ||
      key.startsWith('MYSQL_') ||
      key.startsWith('SESSION_') ||
      key.startsWith('LOGIN_') ||
      key.startsWith('COOKIE_') ||
      key.startsWith('REDIS_') ||
      key === 'PORT'
    ) {
      delete env[key]
    }
  }
  env.DSH_HOME = homeDir
  // platform-identity / ui-platform-account 插件读取(T3)。
  env.PLATFORM_USER_ID = user.userId
  env.PLATFORM_USER_DISPLAY = user.displayName
  env.PLATFORM_GATEWAY_ORIGIN = config.dsh.gatewayOrigin
  // platform-identity 的 cwd 根校验边界(T3)。
  env.PLATFORM_WORKSPACE_ROOT = workspaceRoot
  // Skill Runtime 投影目录:cmcc-skill-provider 只读消费。
  env.PLATFORM_SKILL_PROJECTION_DIR = skillProjectionDir(user.tenantId, user.userId)
  // Knowledge Runtime 投影目录:cmcc-knowledge-runtime 只读消费。
  env.PLATFORM_KNOWLEDGE_PROJECTION_DIR = knowledgeProjectionDir(user.tenantId, user.userId)
  // MCP Runtime 投影目录:cmcc-mcp-observer 写 ack;mcp-client rows 由 patch 注入。
  env.PLATFORM_MCP_PROJECTION_DIR = mcpProjectionDir(user.tenantId, user.userId)
  // MCP 凭据:仅注入当前用户已授权 connector 的解密 secret(变量名由服务端生成)。
  // 绝不全量 dump;绝不写日志;Runtime 退出后 Gateway 不持久化明文。
  for (const [key, value] of Object.entries(mcpSecrets)) {
    env[key] = value
  }
  // Memory Runtime 投影目录 + 内部写回通道(ephemeral token,仅内存)。
  env.PLATFORM_MEMORY_PROJECTION_DIR = memoryProjectionDir(user.tenantId, user.userId)
  env.PLATFORM_MEMORY_INTERNAL_URL = `http://127.0.0.1:${config.port}`
  env.PLATFORM_MEMORY_INTERNAL_TOKEN = memoryToken
  // 通用 Runtime → Gateway 内部通道；身份只由短期 token 推导。
  env.PLATFORM_INTERNAL_URL = `http://127.0.0.1:${config.port}`
  env.PLATFORM_INTERNAL_TOKEN = memoryToken
  env.PLATFORM_MEMORY_MAX_RECALL_ITEMS = String(config.memory.maxRecallItems)
  env.PLATFORM_MEMORY_MAX_RECALL_BYTES = String(config.memory.maxRecallBytes)
  env.PLATFORM_MEMORY_MAX_ITEM_BYTES = String(config.memory.maxItemBytes)
  // 默认 Workspace 引导(服务端生成路径;cmcc-workspace-bootstrap 只读消费)。
  if (defaultWorkspace !== null) {
    env.CMCC_DEFAULT_WORKSPACE_PATH = defaultWorkspace.path
    env.CMCC_DEFAULT_WORKSPACE_TITLE = defaultWorkspace.title
  }
  // dev/test 凭据映射(仅 canary/qualification 测试 Runtime):
  // PLATFORM_TEST_DEEPSEEK_API_KEY → DEEPSEEK_API_KEY。
  //
  // 安全约束:只有当该 runtime 的 homeDir 位于 PLATFORM_DSH_CANARY_ROOT 之下时
  // 才注入。canaryRoot 留空 = 默认拒绝,任何 runtime(含普通用户)都不会获得
  // 测试 Key。源变量名以 PLATFORM_ 开头,已在上面的循环中从子进程 env 剔除,
  // 因此不会原样透传给 DSH。值不落 DB/API/日志/audit。生产凭据模型不变。
  const testKey = process.env.PLATFORM_TEST_DEEPSEEK_API_KEY
  if (testKey !== undefined && testKey !== '' && config.dsh.canaryRoot !== '' && isUnderCanaryRoot(homeDir)) {
    env.DEEPSEEK_API_KEY = testKey
  }
  // TODO(T2 凭据): 生产从 t_dsh_provider_credentials 解密后注入 DEEPSEEK_API_KEY。
  return env
}

/** homeDir 是否位于配置的 canary 测试根之下(默认拒绝)。 */
function isUnderCanaryRoot(homeDir: string): boolean {
  const root = path.resolve(config.dsh.canaryRoot)
  const target = path.resolve(homeDir)
  const rel = path.relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * 解密当前用户已授权 connector 的凭据,构造 child env 注入表。
 * 只包含该用户的 server;变量名由服务端生成;失败项跳过(observer 报告 missing)。
 * 返回值仅在内存中短暂存在,不写日志/DB/patch。
 */
async function loadMcpSecrets(servers: ProjectedServer[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const server of servers) {
    if (server.credentialEnvVar === null) continue
    const envelope = await mcpRepository.getCredentialEnvelope(server.connectorId)
    if (envelope === null) continue
    try {
      out[server.credentialEnvVar] = getCredentialStore().open(envelope)
    } catch {
      // 解密失败:不注入;Runtime 该 server 将缺凭据。
    }
  }
  return out
}

/**
 * 拉起 dsh 实例。
 *
 * 优先使用显式 launcher:`spawn(nodeBin, [cliEntry, ...args])`。
 * 这是 0.1.5+ 的必需路径——其 CLI 使用 `import.meta.main`,在 Node 24.0.0/24.1.x
 * 上为 undefined 会静默退出,且 PATH 上的 `dsh` 垫片无法钉住 Node 版本。
 *
 * 未配置 nodeBin/cliEntry 时回退到 PATH 上的 `bin`(0.1.1 兼容)。
 * Windows 下 `dsh` 是 .cmd/.ps1 垫片,回退路径需经 shell;显式 node+entry 不需要。
 */
function spawnDsh(args: string[], options: SpawnOptions): ChildProcess {
  const { nodeBin, cliEntry, bin } = config.dsh
  if (nodeBin !== '' && cliEntry !== '') {
    return spawn(nodeBin, [cliEntry, ...args], options)
  }
  if (process.platform === 'win32') {
    return spawn([bin, ...args].join(' '), { ...options, shell: true })
  }
  return spawn(bin, args, options)
}

/** launcher 预检结果。 */
export interface DshLauncherProbe {
  ok: boolean
  nodeVersion: string | null
  dshVersion: string | null
  error?: string
}

/** 需要显式测试通过的 Node 版本(避免 0.1.5 静默退出)。 */
const VERIFIED_NODE_PREFIXES = ['v24.11.', 'v24.12.', 'v22.19.', 'v22.20.']

/**
 * 预检 launcher:执行 `<nodeBin> --version` 与 `<nodeBin> <cliEntry> --version`。
 * 仅在显式配置 nodeBin/cliEntry 时执行;否则视为 N/A(回退模式)。
 */
export async function probeDshLauncher(): Promise<DshLauncherProbe> {
  const { nodeBin, cliEntry } = config.dsh
  if (nodeBin === '' || cliEntry === '') {
    return { ok: true, nodeVersion: null, dshVersion: null, error: 'launcher-not-configured (fallback to PATH bin)' }
  }
  const run = (bin: string, args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let out = ''
      child.stdout?.on('data', (c: Buffer) => { out += c.toString('utf8') })
      child.stderr?.on('data', (c: Buffer) => { out += c.toString('utf8') })
      child.once('error', (err) => reject(err))
      child.once('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${String(code)}: ${out.trim()}`))))
    })
  try {
    const nodeVersion = (await run(nodeBin, ['--version'])).split('\n')[0] ?? ''
    const dshVersion = (await run(nodeBin, [cliEntry, '--version'])).split('\n')[0] ?? ''
    if (!VERIFIED_NODE_PREFIXES.some((p) => nodeVersion.startsWith(p))) {
      return { ok: false, nodeVersion, dshVersion, error: `Node ${nodeVersion} 未经测试通过(需要 24.11+/22.19+)` }
    }
    if (!dshVersion.startsWith('0.1.5')) {
      return { ok: false, nodeVersion, dshVersion, error: `DSH ${dshVersion} 非目标 0.1.5-rc.2` }
    }
    return { ok: true, nodeVersion, dshVersion }
  } catch (err) {
    return { ok: false, nodeVersion: null, dshVersion: null, error: (err as Error).message }
  }
}

// --- t_dsh_runtimes 注册表(审计与路由;失败不阻断业务) ---

function registerRuntimeRow(runtime: RuntimeInfo): void {
  void execute(
    `INSERT INTO t_dsh_runtimes (id, user_id, host, dsh_version, state, last_heartbeat, pid)
     VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3), ?)
     ON DUPLICATE KEY UPDATE state = VALUES(state), last_heartbeat = UTC_TIMESTAMP(3), pid = VALUES(pid)`,
    [runtime.runtimeId, runtime.userId, config.dsh.bindHost, config.dsh.version, runtime.state, runtime.pid],
  ).catch(() => undefined)
}

function updateRuntimeState(runtimeId: string, state: RuntimeState): void {
  void execute('UPDATE t_dsh_runtimes SET state = ?, last_heartbeat = UTC_TIMESTAMP(3) WHERE id = ?', [
    state,
    runtimeId,
  ]).catch(() => undefined)
}

function touchRuntimeRow(runtimeId: string): void {
  void execute('UPDATE t_dsh_runtimes SET last_heartbeat = UTC_TIMESTAMP(3) WHERE id = ?', [runtimeId]).catch(
    () => undefined,
  )
}

// --- 生命周期 ---

/**
 * ensureRuntime(总方案 §8 / platform 设计 T2):
 * 复用存活实例(刷新活动时间),否则拉起 `dsh web --no-open --host 127.0.0.1 --port <p>
 * --trusted-host <authority>`,从 stdout 的 `dsh web: http://127.0.0.1:<port>` 行判定就绪。
 * dsh 0.1.1-rc.2 的 Web 面不做令牌认证,仅按 Host/Origin 可达性围栏。
 */
export async function ensureRuntime(user: RuntimeUser | AuthenticatedPrincipal): Promise<RuntimeInfo> {
  const userId = user.userId
  const existing = registry.get(userId)
  if (existing !== undefined && existing.state === 'ready') {
    existing.lastActivity = Date.now()
    existing.lastHeartbeat = Date.now()
    touchRuntimeRow(existing.runtimeId)
    return existing
  }
  const pending = inflight.get(user.userId)
  if (pending !== undefined) return pending

  const task = spawnRuntime(user).finally(() => inflight.delete(user.userId))
  inflight.set(user.userId, task)
  return task
}

async function spawnRuntime(user: RuntimeUser): Promise<RuntimeInfo> {
  const homeDir = path.join(config.dsh.homesRoot, user.tenantId, user.userId)
  const workspaceRoot = path.join(config.dsh.workspacesRoot, user.tenantId, user.userId)
  await mkdir(homeDir, { recursive: true })
  await mkdir(workspaceRoot, { recursive: true })

  // Runtime preflight: 0.1.1 → 0.1.5 agent-preset upgrade compatibility.
  // A stale `agent-presets.default: code` would make every new Session fail with
  // `agent-preset/not-found`; migrate it to `ptc` before the Runtime spawns.
  try {
    const migration = await migrateAgentPresetSetting(homeDir)
    if (migration.status === 'migrated') {
      process.stderr.write(`[agent-preset-migration] ${user.userId}: ${migration.from} -> ${migration.to}\n`)
    } else if (migration.status === 'error') {
      process.stderr.write(`[agent-preset-migration] ${user.userId}: error ${migration.reason}\n`)
    }
  } catch (err) {
    process.stderr.write(`[agent-preset-migration] ${user.userId}: failed ${String(err)}\n`)
  }

  // Runtime start / ensureRuntime:启动前重建该用户 Skill 投影,确保首启即见正确 catalog。
  const __t0 = performance.now()
  const __skipProjections = process.env.PLATFORM_SKIP_PROJECTIONS === '1'
  process.stderr.write(`[timing] PROJECTION_SKILL_BEGIN user=${user.userId}\n`)
  try {
    if (!__skipProjections) await buildSkillProjection(user.tenantId, user.userId)
  } catch (err) {
    process.stderr.write(`[skill-projection] build failed for ${user.userId}: ${String(err)}\n`)
  }
  const __t1 = performance.now()
  process.stderr.write(`[timing] PROJECTION_SKILL_END duration_ms=${(__t1 - __t0).toFixed(0)}\n`)
  process.stderr.write(`[timing] PROJECTION_KNOWLEDGE_BEGIN user=${user.userId}\n`)
  try {
    if (!__skipProjections) await knowledgeService.buildProjection(user.userId, user.tenantId)
  } catch (err) {
    process.stderr.write(`[knowledge-projection] build failed for ${user.userId}: ${String(err)}\n`)
  }
  const __t2 = performance.now()
  process.stderr.write(`[timing] PROJECTION_KNOWLEDGE_END duration_ms=${(__t2 - __t1).toFixed(0)}\n`)
  process.stderr.write(`[timing] PROJECTION_MEMORY_BEGIN user=${user.userId}\n`)
  try {
    if (!__skipProjections) await memoryService.buildProjection(user.userId, user.tenantId)
  } catch (err) {
    process.stderr.write(`[memory-projection] build failed for ${user.userId}: ${String(err)}\n`)
  }
  const __t3 = performance.now()
  process.stderr.write(`[timing] PROJECTION_MEMORY_END duration_ms=${(__t3 - __t2).toFixed(0)}\n`)
  const memoryToken = issueRuntimeToken(user.userId, user.tenantId)
  // Runtime start:确保用户默认 Workspace(服务端 provisioning;普通用户无需 native picker)。
  let defaultWorkspace: { path: string; title: string } | null = null
  try {
    defaultWorkspace = await ensureDefaultWorkspace(user.userId, user.tenantId)
  } catch (err) {
    process.stderr.write(`[workspace-bootstrap] ensure failed for ${user.userId}: ${String(err)}\n`)
  }
  // Runtime start:重建该用户 MCP 投影,并解密其 authorized connector 凭据(仅内存)。
  let mcpEntries: McpPatchEntry[] = []
  let mcpSecrets: Record<string, string> = {}
  try {
    await buildMcpProjection(user.tenantId, user.userId)
    const projection = await readMcpProjection(user.tenantId, user.userId)
    if (projection !== null) {
      mcpEntries = renderMcpPatchEntries(projection)
      mcpSecrets = await loadMcpSecrets(projection.servers)
    }
  } catch (err) {
    // 投影/凭据失败不阻塞 Runtime 启动;observer 将报告缺失。
    process.stderr.write(`[mcp-projection] build failed for ${user.userId}: ${String(err)}\n`)
  }

  const now = Date.now()
  const base: RuntimeInfo = {
    runtimeId: randomUUID(),
    userId: user.userId,
    tenantId: user.tenantId,
    state: 'starting',
    homeDir,
    workspaceRoot,
    upstreamUrl: config.dsh.mockUpstream ?? '',
    port: null,
    pid: null,
    authority: config.dsh.uiAuthority,
    launchToken: null,
    bootstrapInFlight: null,
    lastBootstrappedSid: null,
    startedAt: now,
    lastHeartbeat: now,
    lastActivity: now,
  }

  // 开发联调:未安装 dsh 时固定代理到 mock 上游,不拉起进程。
  if (config.dsh.mockUpstream !== null) {
    base.state = 'ready'
    base.upstreamUrl = config.dsh.mockUpstream
    registry.set(user.userId, base)
    return base
  }

  const port = await getFreePort()
  base.port = port
  base.upstreamUrl = `http://127.0.0.1:${port}`

  const globalArgs: string[] = []
  const __t4a = performance.now()
  process.stderr.write(`[timing] RUNTIME_PATCH_BEGIN user=${user.userId}\n`)
  try {
    const patchPath = await deployPlatformPatch(homeDir, mcpEntries)
    if (patchPath) globalArgs.push('--patch', patchPath)
  } catch { /* 补丁失败不阻塞 */ }
  const __t4 = performance.now()
  process.stderr.write(`[timing] RUNTIME_PATCH_END duration_ms=${(__t4 - __t4a).toFixed(0)}\n`)

  const spawnArgs = [...globalArgs, '--profile', 'web', '--no-open', '--host', config.dsh.bindHost, '--port', String(port),
    '--trusted-host', config.dsh.uiAuthority]
  const childEnvironment = childEnv(homeDir, workspaceRoot, user, mcpSecrets, memoryToken, defaultWorkspace)

  // Guarded diagnostic: dump the exact spawn command + child env (secret values
  // redacted) so a silent startup hang can be diffed against a manual boot.
  if (process.env.PLATFORM_DSH_DEBUG_ENV === '1') {
    const redacted: Record<string, string> = {}
    for (const [k, v] of Object.entries(childEnvironment)) {
      redacted[k] = /KEY|TOKEN|SECRET|PASSWORD/i.test(k) ? '[REDACTED]' : (v ?? '')
    }
    const { nodeBin, cliEntry, bin } = config.dsh
    const exe = nodeBin !== '' && cliEntry !== '' ? nodeBin : bin
    void writeFile(path.join(config.repoRoot, 'var', 'final-e2e', 'dsh-child-env.json'), JSON.stringify({ exe, args: spawnArgs, cwd: homeDir, env: redacted }, null, 2), 'utf8').catch(() => undefined)
  }

  process.stderr.write(`[timing] PROCESS_SPAWN_BEGIN user=${user.userId}\n`)
  const child = spawnDsh(spawnArgs, {
    cwd: homeDir,
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  base.pid = child.pid ?? null
  children.set(user.userId, child)
  const __t5 = performance.now()
  process.stderr.write(`[timing] PROCESS_SPAWNED pid=${String(child.pid)}\n`)

  return new Promise<RuntimeInfo>((resolve, reject) => {
    let buffer = ''
    // Bounded combined stdout/stderr tail for startup-failure diagnostics (redacted).
    let outputTail = ''
    const pushOutput = (chunk: string): void => {
      outputTail = (outputTail + chunk).slice(-4000)
    }
    const timer = setTimeout(() => {
      // A timed-out startup must not leak the child (it may hold DSH_HOME locks).
      try { child.kill() } catch { /* */ }
      reject(new Error(`dsh 实例启动超时(未在 30s 内输出 \`dsh web:\` 行); output tail: ${redactToken(outputTail).slice(-1200)}`))
    }, 30_000)

    const onChunk = (chunk: string): void => {
      pushOutput(chunk)
      buffer += chunk
      // 0.1.5+ 启动行:`dsh web: http://127.0.0.1:<port>/?token=<launchToken>`
      // 0.1.1  启动行:`dsh web: http://127.0.0.1:<port>`
      const match = buffer.match(/dsh web:\s*(https?:\/\/\S+)/)
      if (match === null || match[1] === undefined) return
      let parsed: URL
      try {
        parsed = new URL(match[1])
      } catch {
        return
      }
      const readyPort = Number(parsed.port)
      clearTimeout(timer)
      base.port = Number.isFinite(readyPort) && readyPort > 0 ? readyPort : port
      base.upstreamUrl = `http://127.0.0.1:${base.port}`
      // launch token 仅存内存;绝不写 DB/audit/日志/浏览器 API。
      const token = parsed.searchParams.get('token')
      base.launchToken = token !== null && token !== '' ? token : null
      base.state = 'ready'
      base.lastHeartbeat = Date.now()
      base.lastActivity = Date.now()
      registry.set(user.userId, base)
      registerRuntimeRow(base)
      const __readyMs = performance.now() - __t5
      process.stderr.write(
        `[runtime_spawn_trace] user=${user.userId} skip_projections=${__skipProjections ? 1 : 0}` +
        ` skill_projection_ms=${(__t1 - __t0).toFixed(0)}` +
        ` knowledge_projection_ms=${(__t2 - __t1).toFixed(0)}` +
        ` memory_projection_ms=${(__t3 - __t2).toFixed(0)}` +
        ` patch_ms=${(__t4 - __t3).toFixed(0)}` +
        ` process_spawn_ms=${(__t5 - __t4).toFixed(0)}` +
        ` ready_wait_ms=${__readyMs.toFixed(0)}` +
        ` total_ms=${performance.now() - __t0}\n`,
      )
      resolve(base)
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', onChunk)
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      // 子进程 stderr 也可能回显启动 URL,统一脱敏后再落日志。
      pushOutput(chunk)
      if (chunk.trim() !== '') process.stderr.write(`[dsh:${user.userId}] ${redactToken(chunk)}`)
    })
    child.once('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`拉起 dsh 失败(${config.dsh.bin}):${err.message}`))
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      children.delete(user.userId)
      // Runtime 退出:轮换/吊销 internal channel token。
      revokeRuntimeToken(user.userId)
      const current = registry.get(user.userId)
      if (current !== undefined) {
        // 进程退出:清空内存中的 launch token,旧 token 不得复用。
        current.launchToken = null
        current.bootstrapInFlight = null
        current.lastBootstrappedSid = null
        updateRuntimeState(current.runtimeId, 'dead')
        registry.delete(user.userId)
      }
      if (base.state !== 'ready') {
        reject(new Error(`dsh 实例在就绪前退出(code=${String(code)}, signal=${String(signal)})`))
      }
    })
  })
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** 优雅排空:标记 draining → 终止进程 → 清路由(总方案 §8.3)。 */
export async function drainRuntime(userId: string): Promise<void> {
  const runtime = registry.get(userId)
  if (runtime === undefined) return
  runtime.state = 'draining'
  updateRuntimeState(runtime.runtimeId, 'draining')
  const child = children.get(userId)
  if (child !== undefined) {
    child.kill()
    await waitForExit(child, 5000)
  }
  children.delete(userId)
  registry.delete(userId)
  updateRuntimeState(runtime.runtimeId, 'dead')
}

/** 空闲回收巡检:全部会话空闲超过 idleTtlMs 即回收。 */
export function startIdleReaper(log: { info: (m: string) => void; error: (m: string) => void }): () => void {
  const interval = Math.max(5_000, Math.min(60_000, Math.floor(config.dsh.idleTtlMs / 4)))
  const timer = setInterval(() => {
    const now = Date.now()
    for (const runtime of listRuntimes()) {
      if (runtime.state !== 'ready') continue
      if (now - runtime.lastActivity < config.dsh.idleTtlMs) continue
      log.info(`idle runtime for user ${runtime.userId} (> ${config.dsh.idleTtlMs}ms), draining`)
      void drainRuntime(runtime.userId).catch((err: unknown) =>
        log.error(`drain failed for ${runtime.userId}: ${String(err)}`),
      )
    }
  }, interval)
  timer.unref()
  return () => clearInterval(timer)
}

/** 进程与路由清理(网关关闭)。 */
export function shutdownRuntimes(): void {
  for (const runtime of listRuntimes()) {
    updateRuntimeState(runtime.runtimeId, 'dead')
  }
  for (const child of children.values()) {
    child.kill()
  }
  children.clear()
  registry.clear()
}
