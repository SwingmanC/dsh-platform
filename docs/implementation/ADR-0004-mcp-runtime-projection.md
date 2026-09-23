# ADR-0004 — MCP Runtime Projection Strategy

> 状态:已实现
> 日期:2026-09-18
> 关联:Phase 06 MCP Runtime Projection

---

## 背景

平台需要把"用户已授权的 MCP connector"投影进 DSH Runtime,由官方
`@deepseek-ai/dsh-mcp-client` 连接并注册 `mcp__<serverName>__<tool>` 工具。

## 决策

### 1. 复用官方 dsh-mcp-client,不重写 MCP 客户端

```
Platform DB (authoritative)
  → Gateway 判定 approval/authorization/transport/credential
  → 生成每用户 patch:每 connector 一个 @deepseek-ai/dsh-mcp-client instance
  → Runtime 启动注入解密 secret 到 child env
  → 官方 mcp-client 连接 + 注册工具
  → cmcc-mcp-observer 观测 ctx.tools 写 ack
```

### 2. Apply mode = CONTROLLED_RUNTIME_RESTART

- 平台使用生成 patch + per-user runtime,`--patch` 在启动时读取
- 修改 patch 不保证运行中自动热加载(未依赖未公开 API)
- 因此 authorize/revoke/approve/credential 变更后:
  - 立即重建投影(desired revision 改变)
  - 状态显示 `SYNCING` / `RESTART_REQUIRED`
  - 由 supervisor 在下次 ensureRuntime 时应用(或受控重启当前用户 Runtime)
- UI 如实显示,不把 controlled restart 冒充 hot reload

### 3. serverName 稳定标识

- 使用现有 `server_name` 列(非 display name)
- 创建/审批时校验 `[A-Za-z0-9_-]{1,32}`
- 同一用户 authorize 时做冲突检查(服务端拒绝)

### 4. Credential envelope

- AES-256-GCM,`v1.<iv-b64url>.<tag-b64url>.<ct-b64url>`
- master key 仅从 `PLATFORM_SECRET_ENCRYPTION_KEY` 读取
- 存入现有 `ciphertext` VARBINARY,无需 migration
- 投影/patch 只含 env reference,不含 value

### 5. Secret 注入

```
Gateway spawnRuntime
  → readMcpProjection
  → loadMcpSecrets:open(envelope) → { CMCC_MCP_SECRET_<opaque>: value }
  → childEnv 注入(仅该用户)
  → patch 中 !!js '\`Bearer ${process.env.CMCC_MCP_SECRET_<opaque>}\`'
```

- env var 名由 connectorId SHA256 派生,不含用户输入
- 不写日志/DB/patch/audit
- Runtime 退出后不持久化明文

### 6. 观测 evidence

- `cmcc-mcp-observer`(Host-only)读取 `ctx.tools.schemas()`,提取 `mcp__*`
- 写 `ack.json`(observed servers + toolCount)
- Gateway 对比 desired servers(projection)与 observed servers(ack):
  - 一致 → CONNECTED
  - 缺失 → RESTART_REQUIRED
  - Runtime 未运行 → RUNTIME_STOPPED
  - ack.error → ERROR

## 安全边界

- approved + authorized + active + transport policy + credential 完整才投影
- stdio 默认禁用(`STDIO_RUNTIME = DISABLED_IN_PHASE_06`)
- streamable-http URL 需通过 egress policy(allowlist / canary loopback)
- 每用户独立 DSH_HOME/进程/投影;A/B 工具与 secret 隔离
- 不依赖 DSH 的 env scrub 替代平台策略(defense in depth)