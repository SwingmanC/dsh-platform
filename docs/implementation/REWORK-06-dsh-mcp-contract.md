# REWORK-06 — DSH 0.1.5-rc.2 MCP Contract(固定 tag)

> 日期:2026-09-18
> 真源:`.tools/dsh-0.1.5-rc.2/node_modules/@deepseek-ai/dsh-mcp-client/`
> 版本:`0.1.5-rc.2`

---

## 1. 包与插件

```ts
export declare const name = 'mcp-client'
export declare const inject: string[]   // ['tools']
export declare function apply(ctx: Context, config: Config): Promise<void>
```

- 命名空间插件(无 default export)
- 每个 plugin instance 连接一个 MCP server
- apply 是 async:连接 + 初始工具发现完成后才 resolve

## 2. Config = StdioConfig | StreamableHttpConfig

### StreamableHttpConfig

```ts
interface StreamableHttpConfig {
  transport: 'streamable-http'
  serverName: string        // [A-Za-z0-9_-]{1,32},同一注册 scope 内唯一
  url: string
  headers: Record<string, string>
  toolCallTimeoutMs: number       // 默认 60000
  failOnStartupError: boolean     // 默认 false
  reconnect?: ReconnectConfig
}
```

### StdioConfig

```ts
interface StdioConfig {
  transport: 'stdio'
  serverName: string
  command: string
  args: string[]
  env: Record<string, string>   // 合并到 scrubbed ambient env
  cwd: string
  toolCallTimeoutMs: number
  failOnStartupError: boolean
  reconnect?: ReconnectConfig
}
```

## 3. ReconnectConfig

```ts
interface ReconnectConfig {
  enabled?: boolean          // 默认 true
  initialDelayMs?: number    // 默认 500
  maxDelayMs?: number        // 默认 30000
  maxAttempts?: number       // 默认 10
}
```

## 4. 工具命名

```
mcp__<serverName>__<rawToolName>
```

- 例:`mcp__crm__search_customer`
- 稳定:相同 (serverName, rawName) → 相同公开名
- 不同 server 的同名 raw tool 不冲突(namespace 隔离)
- 同层重复 serverName → 启动时失败

## 5. 能力边界

```text
MCP Tools     = 桥接到 ctx.tools ✓
MCP Resources = NOT_SUPPORTED_BY_DSH_0.1.5_RC2
MCP Prompts   = NOT_SUPPORTED_BY_DSH_0.1.5_RC2
```

不自行实现 resource/prompt registry 伪装官方支持。

## 6. 生命周期

- dispose → 断开连接 + 注销所有工具 + 释放 serverName namespace
- HMR → dispose 旧 instance + 创建新 instance;相同 serverName 复现相同工具名
- `notifications/tools/list_changed` → 重新同步工具集
- 连接断开 → 有界指数退避重连;耗尽 maxAttempts 后注销工具

## 7. 环境清洗(stdio)

- `scrubbedParentEnv()` 删除匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 及 `DSH_*` 的环境变量
- 再合并 config 的显式 `env`
- 平台层仍需自己的 secret allowlist(defense in depth)

## 8. 工具结果语义

- 规范值 `{ content: JsonValue[], structuredContent? }`
- MCP `isError` → 抛错
- 图片投影为文本/图片块;不支持音频/嵌入资源(降级为文本)
- 输出受 `outputSchema`(若提供)校验

## 9. 平台映射

| 官方字段 | 平台值 |
|----------|--------|
| `name`(plugin) | `@deepseek-ai/dsh-mcp-client` |
| `serverName` | connector `server_name`(稳定,审批时校验) |
| `transport` | `streamable-http`(Phase 06 主路径) |
| `url` | approved connector template |
| `headers.Authorization` | `!!js '\`Bearer ${process.env.CMCC_MCP_SECRET_<opaque>}\`'` |
| `toolCallTimeoutMs` | `PLATFORM_MCP_TOOL_TIMEOUT_MS` |
| `failOnStartupError` | `false`(允许 Runtime 启动,connector 可 DEGRADED) |

## 10. stdio 政策

```text
STDIO_RUNTIME = DISABLED_IN_PHASE_06
```

普通用户不能提交任意 command/args/cwd/env;`PLATFORM_MCP_ALLOW_STDIO=false` 默认拒绝。