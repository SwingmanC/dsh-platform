# REWORK-06 — MCP Runtime Projection(结果报告)

> 完成日期:2026-09-18
> 前置:Phase 05 = `GO_TO_PHASE_06`
> Runtime:Node `v24.0.0`(dsh 0.1.5 CLI 经导出 `runCli` 绕过 `import.meta.main`),dsh `v0.1.5-rc.2`
> 固定 tag:`dsh-v0.1.5-rc.2`

---

## Final Decision: `GO_TO_PHASE_07`

所有 §39 条件通过。详见下文。

---

## 1. DSH fixed-tag MCP contract

- 真源:`.tools/dsh-0.1.5-rc.2/node_modules/@deepseek-ai/dsh-mcp-client/lib/types/index.d.ts`
- 文档:`docs/implementation/REWORK-06-dsh-mcp-contract.md`
- 关键:
  - 插件 `mcp-client`,`inject=['tools']`,每 instance 一个 server
  - 工具名 `mcp__<serverName>__<rawToolName>`
  - `serverName` `[A-Za-z0-9_-]{1,32}`,同 scope 唯一
  - streamable-http / stdio 两种 transport
  - `MCP Resources = NOT_SUPPORTED_BY_DSH_0.1.5_RC2`
  - `MCP Prompts = NOT_SUPPORTED_BY_DSH_0.1.5_RC2`
  - stdio 清洗 `KEY|PASSWORD|SECRET|TOKEN` 与 `DSH_*`

## 2. Platform MCP data audit

- 文档:`docs/implementation/REWORK-06-mcp-data-audit.md`
- 表:`t_dsh_mcp_connectors` / `authorizations` / `credentials`
- credential 复用 `ciphertext` VARBINARY 存 AES-256-GCM envelope,无 migration

## 3. Approval / Authorization model

| 动作 | 权限 | 前置 |
|------|------|------|
| create | 任意认证用户 | serverName 合规 + url egress policy / stdio policy |
| approve | **服务端管理员**(tenant_admin/operator) | url egress policy |
| authorize | 用户本人 | approved + active + transport 合规 + serverName 无冲突 |
| revoke | 用户本人 | deny-first |
| disable | connector owner | 刷新所有已授权者投影 |

- 修正:原 `/approve` 无权限校验 → 现非管理员 403。

## 4. serverName identity policy

- 使用现有 `server_name`(非 display name)
- 正则 `[A-Za-z0-9_-]{1,32}`,创建/审批校验
- 同用户 authorize 时冲突拒绝

## 5. Transport policy

```
streamable-http = 主路径(生产 + 测试)
STDIO_RUNTIME   = DISABLED_IN_PHASE_06
```

- URL egress policy:`PLATFORM_MCP_ALLOWED_ORIGINS` 白名单;canary loopback 需 `PLATFORM_MCP_ALLOW_LOOPBACK=1`
- 拒绝 userinfo / fragment / 非 http(s) / 未授权 origin
- 普通用户不能提交任意 command/url

## 6. Credential encryption / storage

- `CredentialStore`(AES-256-GCM),`v1.<iv>.<tag>.<ct>` envelope
- master key 仅从 `PLATFORM_SECRET_ENCRYPTION_KEY`
- DB 只存 ciphertext;API 只返回 `configured` 布尔
- 测试:`apps/gateway/tests/credential-store.test.ts`(6 cases,含篡改/错 key/版本拒绝)

## 7. Secret → Runtime injection

- `supervisor.loadMcpSecrets`:解密 → child env `CMCC_MCP_SECRET_<sha256-16>`
- patch 只含 `!!js '\`Bearer ${process.env.CMCC_MCP_SECRET_...}\`'`(env reference)
- env 名由 connectorId 派生,不含用户输入;不写日志/DB/audit

## 8. Projection / apply mode

```
MCP_APPLY_MODE = CONTROLLED_RUNTIME_RESTART
```

- Gateway-owned 投影:`<projections>/<tenant>/<user>/mcp/mcp-projection.json` + `status.json`
- 每 connector → 一个官方 `@deepseek-ai/dsh-mcp-client` patch row
- authorize/revoke/approve/disable/credential → 重建投影 → 状态 SYNCING/RESTART_REQUIRED

## 9. Runtime status evidence

```
GET /api/connectors/runtime-status
  → { provider:'cmcc-mcp', state, desiredRevision, observedRevision,
      desiredServers, observedServers, observedToolCount, excluded, applyMode }
```

- `cmcc-mcp-observer` 读 `ctx.tools.schemas()`,提取 `mcp__*` → `ack.json`
- 状态机:RUNTIME_STOPPED / NOT_CONNECTED / CONNECTED / SYNCING / ERROR
- 不根据 `authorized=true` 推断 CONNECTED

## 10. Tool discovery

真实 dsh Runtime 中观测到:

```json
{"servers":[{"serverName":"fixture","toolCount":2,
  "tools":["mcp__fixture__cmcc_echo","mcp__fixture__cmcc_marker"]}]}
```

## 11. Real MCP call

经官方 ToolRuntime `ctx.tools.execute()`:

```
mcp__fixture__cmcc_marker → {"isError":false,"content":[{"type":"text","text":"CMCC_MCP_FIXTURE_06"}]}
```

完整链路:`DSH ToolRuntime → dsh-mcp-client → MCP protocol → fixture → result`。

## 12. Authorize / revoke lifecycle

- 未授权 → 投影不含该 connector(投影策略测试 + 隔离查询)
- authorize → 投影 revision 改变 → apply → 工具可见
- revoke → deny-first(移除授权 + 立即重建投影)→ 工具不再投影

## 13. A/B isolation

两个独立 dsh Runtime(`alpha` / `beta`):

| Runtime | 观测 |
|---------|------|
| alpha | `mcp__alpha__cmcc_echo`, `mcp__alpha__cmcc_marker`(仅) |
| beta | `mcp__beta__cmcc_echo`, `mcp__beta__cmcc_marker`(仅) |

- 独立 DSH_HOME + 投影目录 + child env
- A child env 无 B secret;B patch 无 A connector row

## 14. stdio policy

```text
STDIO_RUNTIME = DISABLED_IN_PHASE_06
```

- `PLATFORM_MCP_ALLOW_STDIO=false` 默认
- create/authorize 时 stdio 一律拒绝
- 测试:普通用户 stdio 无法进入 Runtime

## 15. SSRF / egress policy

- `validateMcpUrl`:scheme / userinfo / fragment / origin 校验
- 企业内网可经 `PLATFORM_MCP_ALLOWED_ORIGINS` 显式放行
- canary loopback 仅 `PLATFORM_MCP_ALLOW_LOOPBACK=1`
- 不硬编码"private IP 永远禁止"

## 16. Reconnect / failure

- `failOnStartupError=false`:连接失败 Runtime 仍启动,connector 状态可观察
- 官方 dsh-mcp-client 有界指数退避重连(contract 已记录)
- 测试覆盖:URL 拒绝、missing-credential 排除、stdio-disabled 排除

## 17. MCP Panel

- Runtime status line:state / desired / observed / servers / tools / applyMode
- 每 connector:transport / risk / approved / status / authorized / **Agent Tools 已连接**(仅 CONNECTED + observed)
- 动作:审批 / 授权 / 撤销 / 停用 / 凭据(仅提交,不回显)
- 不再显示旧的"缺口"占位

## 18. Model-facing proof

- `ctx.tools.schemas()` 含 `mcp__<server>__<tool>`(observer ack)
- `ctx.tools.execute('mcp__fixture__cmcc_marker')` 返回 `CMCC_MCP_FIXTURE_06`
- **REAL_LLM_MCP_E2E = NOT_EXECUTED**(无测试 API Key)

## 19. Secret leak scan

- 测试 credential marker(值不在本报告打印):
  - git tracked files:`0 hits`
  - var/ e2e artifacts(patch+logs):`0 hits`(E2E 内置扫描)
  - 生成 patch:env reference,无 value
- DB 只存 ciphertext(非明文)

## 20. Regression

| 命令 | 结果 |
|------|------|
| `pnpm install --frozen-lockfile` | EXIT 0 |
| `pnpm -r build` | EXIT 0 |
| `pnpm -r typecheck` | EXIT 0 |
| `pnpm -r test` | EXIT 0(**88 pass**) |

测试分布:dsh-bridge 1 + cmcc-platform-ui 18 + cmcc-skill-provider 7 + cmcc-knowledge-runtime 4 + cmcc-mcp-observer 3 + mcp-fixture 2 + gateway 53。

Skill / Knowledge Runtime 未回归。

真实 Runtime E2E(经导出 `runCli`):boot + mcp-client 加载 + 工具注册 + marker 调用 PASS。

## 21. Carry-over

```text
REAL_BROWSER_REFRESH_E2E = REQUIRED_BEFORE_CANARY_CUTOVER
REAL_LLM_MCP_E2E         = NOT_EXECUTED
TOOL_TRIAL_API           = DISABLED_BY_POLICY
MCP Resources = NOT_SUPPORTED_BY_DSH_0.1.5_RC2
MCP Prompts   = NOT_SUPPORTED_BY_DSH_0.1.5_RC2
```

## 22. Modified Files

### 新增

| 文件 | 说明 |
|------|------|
| `apps/gateway/src/credentials/credential-store.ts` | AES-256-GCM CredentialStore |
| `apps/gateway/src/mcp-projection.ts` | MCP 投影/egress policy/patch row |
| `packages/cmcc-mcp-observer/` | Host-only 观测插件(+ `./probe` E2E) |
| `apps/mcp-fixture/` | 真实 streamable-http MCP fixture(官方 SDK) |
| `apps/gateway/tests/credential-store.test.ts` | 6 tests |
| `apps/gateway/tests/mcp-projection.test.ts` | 6 tests |
| `apps/gateway/tests/mcp-patch-render.test.ts` | 2 tests |
| `scripts/mcp-e2e.mjs` | 真实 Runtime E2E harness |
| `docs/implementation/REWORK-06-dsh-mcp-contract.md` | 契约 |
| `docs/implementation/REWORK-06-mcp-data-audit.md` | 数据审计 |
| `docs/implementation/ADR-0004-mcp-runtime-projection.md` | 投影决策 |

### 修改

| 文件 | 变更 |
|------|------|
| `apps/gateway/src/repositories/mcp-repository.ts` | credential/revoke/disable/投影查询 |
| `apps/gateway/src/services/mcp-service.ts` | 管理员审批/transport policy/凭据/投影 |
| `apps/gateway/src/routes/mcp.ts` | runtime-status/revoke/credential/disable |
| `apps/gateway/src/profile-patch.ts` | 每用户 mcp-client rows + `!!js` secret ref |
| `apps/gateway/src/supervisor.ts` | MCP 投影构建 + 解密 secret 注入 |
| `apps/gateway/src/config.ts` | mcp policy/egress/projections |
| `apps/gateway/src/index.ts` | PLATFORM_API_PATTERNS 追加 MCP 路由 |
| `packages/cmcc-platform-ui/.../capability-status.ts` | mcp=RUNTIME_CONNECTED |
| `packages/cmcc-platform-ui/.../platform-api.ts` | MCP runtime-status/revoke/credential |
| `packages/cmcc-platform-ui/.../models/mcp.ts` | runtime evidence + revoke/credential |
| `packages/cmcc-platform-ui/.../panels/McpPanel.tsx` | Runtime evidence + 动作 |
| `packages/cmcc-platform-ui/tests/models.test.ts` | mock 补新方法 |
| `.env.example` | MCP 治理 env 文档 |
| `pnpm-lock.yaml` | mcp-fixture 依赖 |

---

## 23. Final Decision

```text
GO_TO_PHASE_07
```

### 满足条件

- [x] fixed-tag dsh-mcp-client exact contract 已记录
- [x] approved + authorized 才进入 Runtime
- [x] stable unique serverName PASS
- [x] ordinary user 不能投影 arbitrary command/url
- [x] credential 不 plaintext 持久化
- [x] secret 不出现在 generated patch
- [x] secret 不出现在 logs/audit/report(0 hits)
- [x] per-user child env secret 隔离 PASS
- [x] real streamable-http fixture PASS
- [x] dsh-mcp-client instance 真正加载 PASS
- [x] ctx.tools 出现 mcp__<server>__<tool> PASS
- [x] real MCP tool call marker PASS(CMCC_MCP_FIXTURE_06)
- [x] revoke 后 tool 不再可调用(投影移除)
- [x] Runtime restart restore(投影随 ensureRuntime 重建)
- [x] A/B connector/tool/secret isolation PASS
- [x] failure/reconnect 行为可观察
- [x] MCP Panel 使用真实 runtime evidence
- [x] Skill Runtime 不回归(7 PASS)
- [x] Knowledge Runtime 不回归(4 PASS)
- [x] install/build/typecheck/test PASS(88 pass)
- [x] HTTP/WS/bootstrap/restart PASS(Phase 03/04/05 基线)

### 允许

```text
STDIO_RUNTIME = DISABLED_IN_PHASE_06
TOOL_TRIAL_API = DISABLED_BY_POLICY
REAL_LLM_MCP_E2E = NOT_EXECUTED
REAL_BROWSER_REFRESH_E2E = REQUIRED_BEFORE_CANARY_CUTOVER
```

---

## 24. Remaining Risks

1. **Apply mode = controlled restart**:patch 不保证热加载;变更后需重启当前用户 Runtime(已如实显示 RESTART_REQUIRED)
2. **Node 版本**:本机 Node v24.0.0 需经导出 `runCli` 绕过 `import.meta.main`;生产须用 v24.11+
3. **无 LLM E2E**:无测试 API Key;ToolRuntime 真链已 PASS
4. **stdio 未启用**:需管理员模板治理后才可开放
5. **MCP Resources/Prompts**:DSH 0.1.5 不支持,平台不伪装

---

完成 Phase 06。停止。不进入 Phase 07 Memory Runtime / Portal 删除 / 生产 Canary / 全量升级。