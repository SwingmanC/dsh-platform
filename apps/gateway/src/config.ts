import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 网关配置(platform 设计 §3/§8)。所有秘密只经环境注入,绝不硬编码。
 * 加载顺序:仓库根 .env → 网关包目录 .env(已存在的进程环境变量优先)。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')

for (const envFile of [path.join(repoRoot, '.env'), path.resolve(here, '../.env')]) {
  try {
    process.loadEnvFile(envFile)
  } catch {
    // 文件不存在或 Node 版本不支持:忽略,改用进程环境。
  }
}

function str(name: string, fallback: string): string {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

function num(name: string, fallback: number): number {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  return v === '1' || v.toLowerCase() === 'true'
}

const isProd = str('NODE_ENV', 'development') === 'production'

/** 开发期未配置 SESSION_SECRET 时生成临时密钥(重启即失效);生产必须显式配置。 */
function resolveSessionSecret(): string {
  const configured = process.env.SESSION_SECRET
  if (configured && configured.length >= 16) return configured
  if (isProd) {
    throw new Error('SESSION_SECRET 必须在生产环境配置(≥16 字符)')
  }
  return randomBytes(32).toString('hex')
}

/**
 * authority 会被拼进 shell 命令(Windows 下 dsh 是 .cmd 垫片),必须是裸 host[:port],
 * 拒绝任何可被解释为命令元字符的输入。
 */
function resolveAuthority(name: string, fallback: string): string {
  const raw = str(name, fallback)
  if (!/^[A-Za-z0-9.\-]+(?::\d{1,5})?$/.test(raw)) {
    throw new Error(`${name} 非法(仅允许 host[:port]):${raw}`)
  }
  return raw
}

const dshUiAuthority = resolveAuthority('PLATFORM_DSH_UI_AUTHORITY', 'dsh.localhost:8080')
const platformAuthority = resolveAuthority('PLATFORM_AUTHORITY', 'localhost:5173')

export const config = {
  isProd,
  repoRoot,
  port: num('PORT', 8080),
  host: str('HOST', '0.0.0.0'),

  mysql: {
    host: str('MYSQL_HOST', '127.0.0.1'),
    port: num('MYSQL_PORT', 3306),
    user: str('MYSQL_USER', 'root'),
    password: str('MYSQL_PASSWORD', ''),
    database: str('MYSQL_DATABASE', 'dsh_platform'),
  },

  /** 浏览器会话(platform 设计 §3.1):sid → {userId, deviceId, ...}。 */
  session: {
    secret: resolveSessionSecret(),
    cookieName: 'sid',
    csrfCookieName: 'csrf_token',
    csrfHeaderName: 'x-csrf-token',
    ttlMs: num('SESSION_TTL_HOURS', 168) * 3600_000,
    /** Secure 需 HTTPS;本地 http 开发默认关闭。 */
    cookieSecure: bool('COOKIE_SECURE', isProd),
    /** SameSite=Lax:不阻断 OIDC 回跳与平台内部跳转(platform 设计 §3.1)。 */
    sameSite: 'lax' as const,
    /**
     * 跨 authority 共享 sid(平台首页与 dsh UI 为不同主机名)。
     * 开发:`.localhost`;生产:`.<父域>`(如 .corp.example)。留空 = host-only。
     */
    cookieDomain: process.env.SESSION_COOKIE_DOMAIN && process.env.SESSION_COOKIE_DOMAIN !== ''
      ? process.env.SESSION_COOKIE_DOMAIN
      : null,
  },

  redisUrl: process.env.REDIS_URL && process.env.REDIS_URL !== '' ? process.env.REDIS_URL : null,

  /** 登录防爆破(platform 设计 §10)。 */
  loginGuard: {
    maxAttempts: num('LOGIN_MAX_ATTEMPTS', 5),
    windowMs: num('LOGIN_WINDOW_MS', 15 * 60_000),
    lockoutMs: num('LOGIN_LOCKOUT_MS', 15 * 60_000),
  },

  /** 平台首页(未认证时 dsh UI 回跳此处登录)。 */
  platform: {
    authority: platformAuthority,
    scheme: str('PLATFORM_SCHEME', isProd ? 'https' : 'http'),
  },

  dsh: {
    /**
     * 拉起 dsh 实例的 launcher 配置。
     *
     * 0.1.5+ 的 `dsh` CLI 使用 `import.meta.main`,在 Node 24.0.0/24.1.x 上为
     * undefined 会导致进程静默退出(exit 0)。因此 Canary/生产必须显式指定
     * node 可执行文件与 CLI 入口,而不是依赖 PATH 上的 `dsh` 垫片。
     *
     * 未配置 nodeBin/cliEntry 时回退到 `bin`(兼容 0.1.1 的 PATH 方式)。
     */
    nodeBin: str('PLATFORM_DSH_NODE_BIN', ''),
    cliEntry: str('PLATFORM_DSH_CLI_ENTRY', ''),
    /** 回退:拉起 dsh 实例的命令(PATH 解析);生产钉版本(总方案 §9)。 */
    bin: str('PLATFORM_DSH_BIN', 'dsh'),
    /** 实例绑定的 loopback 地址(dsh web-server 仅接受 127.0.0.1/0.0.0.0)。 */
    bindHost: str('PLATFORM_DSH_BIND_HOST', '127.0.0.1'),
    /**
     * dsh Web UI 的专属 authority(浏览器直接访问其根路径)。
     * dsh 0.1.1-rc.2 前端使用根绝对路径,无法挂在子路径下,故需独立 authority;
     * 网关按 Host 路由(Fastify host 约束按完整 Host 含端口匹配),并以该值作为
     * 实例的 --trusted-host。
     */
    uiAuthority: dshUiAuthority,
    /** 每用户 home / workspace 根(相对路径以仓库根为基准解析)。 */
    homesRoot: path.resolve(repoRoot, str('PLATFORM_DSH_HOMES_ROOT', './var/homes')),
    workspacesRoot: path.resolve(repoRoot, str('PLATFORM_DSH_WORKSPACES_ROOT', './var/workspaces')),
    /**
     * Skill Runtime 投影根(Gateway-owned derived projection,非业务 source of truth)。
     * 路径:<root>/<tenantId>/<userId>/skills/{catalog.json,bodies/,status.json,ack.json}。
     * DSH Provider 只读消费;Runtime 经 PLATFORM_SKILL_PROJECTION_DIR 注入该用户目录。
     */
    projectionsRoot: path.resolve(repoRoot, str('PLATFORM_DSH_PROJECTIONS_ROOT', './var/projections')),
    /** 钉住的 dsh 版本(写入 t_dsh_runtimes;dev preview 必须锁版本)。 */
    version: str('PLATFORM_DSH_VERSION', '0.1.1-rc.2'),
    /** 空闲回收 TTL(毫秒):全部会话空闲超过该时长 → 优雅排空并回收进程。 */
    idleTtlMs: num('PLATFORM_DSH_IDLE_TTL_MS', 30 * 60_000),
    /** 心跳间隔(毫秒)。 */
    heartbeatMs: num('PLATFORM_DSH_HEARTBEAT_MS', 30_000),
    /**
     * Canary/qualification 测试 home 根(绝对路径)。
     *
     * 安全约束:`PLATFORM_TEST_DEEPSEEK_API_KEY` 只在 runtime 的 homeDir 位于
     * 该根之下时才映射为子进程的 `DEEPSEEK_API_KEY`。留空 = 默认拒绝,
     * 任何 runtime(含普通用户)都不会获得测试 Key。生产凭据模型不受影响。
     */
    canaryRoot: str('PLATFORM_DSH_CANARY_ROOT', ''),
    /** 注入实例的网关 origin(platform-identity / ui-platform-account 用)。 */
    gatewayOrigin: str('PLATFORM_GATEWAY_ORIGIN', `http://${platformAuthority}`),
    /**
     * 开发联调:未安装 dsh 时,把 dsh UI 固定代理到该上游(如 http://127.0.0.1:3080),
     * 跳过进程拉起。生产不设置。
     */
    mockUpstream: process.env.PLATFORM_DSH_MOCK_UPSTREAM || null,
  },

  /** Knowledge 文档存储与投影根(Gateway-owned,非业务 source of truth)。 */
  knowledge: {
    storageRoot: path.resolve(repoRoot, str('PLATFORM_KNOWLEDGE_STORAGE_ROOT', './var/knowledge-storage')),
    projectionsRoot: path.resolve(repoRoot, str('PLATFORM_KNOWLEDGE_PROJECTIONS_ROOT', './var/projections')),
  },

  /**
   * MCP Runtime 治理策略。
   * - allowStdio:普通用户 stdio 默认禁用(arbitrary process execution carrier)。
   * - allowedOrigins:streamable-http 允许的 origin 白名单(空 = 仅 canary loopback)。
   * - allowLoopback:仅 canary/test 放行 127.0.0.1(生产默认 false)。
   * - credentialKey:从 env 读取,不落 repo。
   */
  mcp: {
    allowStdio: bool('PLATFORM_MCP_ALLOW_STDIO', false),
    allowLoopback: bool('PLATFORM_MCP_ALLOW_LOOPBACK', false),
    allowedOrigins: (process.env.PLATFORM_MCP_ALLOWED_ORIGINS ?? '')
      .split(',').map((s) => s.trim()).filter((s) => s !== ''),
    projectionsRoot: path.resolve(repoRoot, str('PLATFORM_MCP_PROJECTIONS_ROOT', './var/projections')),
    toolCallTimeoutMs: num('PLATFORM_MCP_TOOL_TIMEOUT_MS', 60_000),
  },

  /**
   * Memory Runtime 治理策略。
   * - 默认只投影 personal/private(team runtime 默认禁用)。
   * - recall 有界:items/bytes/itemBytes。
   * - autoExtraction:确定性显式提取(可在 canary 关闭)。
   */
  memory: {
    projectionsRoot: path.resolve(repoRoot, str('PLATFORM_MEMORY_PROJECTIONS_ROOT', './var/projections')),
    maxRecallItems: num('PLATFORM_MEMORY_MAX_RECALL_ITEMS', 8),
    maxRecallBytes: num('PLATFORM_MEMORY_MAX_RECALL_BYTES', 4096),
    maxItemBytes: num('PLATFORM_MEMORY_MAX_ITEM_BYTES', 512),
    teamRuntimeEnabled: bool('PLATFORM_MEMORY_TEAM_RUNTIME', false),
    autoExtraction: bool('PLATFORM_MEMORY_AUTO_EXTRACTION', true),
  },
} as const

export type GatewayConfig = typeof config
