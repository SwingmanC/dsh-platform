# REWORK-08 — Canary Configuration (Draft, NOT activated)

> 日期:2026-09-18
> 状态:DRAFT — 未启用任何 Canary。本文件仅定义启动检查项。

---

## 1. Target

| 项 | 值 |
|----|----|
| DSH target | `0.1.5-rc.2`(钉版本,不升级) |
| Node | `v24.11.0`(显式 `PLATFORM_DSH_NODE_BIN`) |
| CLI entry | 显式 `PLATFORM_DSH_CLI_ENTRY` → `@deepseek-ai/dsh/lib/bin.js` |
| launcher preflight | 必须 `dsh launcher ok: node=v24.11.0 dsh=0.1.5-rc.2` |

## 2. 必需基础设施

```text
Redis          = REQUIRED (不得 memory fallback)
MySQL          = REQUIRED (migration 007 已应用)
SECRET key     = PLATFORM_SECRET_ENCRYPTION_KEY (env, ≥32B)
Gateway session store = redis
```

## 3. Roots

```text
PLATFORM_DSH_HOMES_ROOT
PLATFORM_DSH_WORKSPACES_ROOT
PLATFORM_DSH_PROJECTIONS_ROOT
PLATFORM_KNOWLEDGE_STORAGE_ROOT
PLATFORM_KNOWLEDGE_PROJECTIONS_ROOT
PLATFORM_MCP_PROJECTIONS_ROOT
PLATFORM_MEMORY_PROJECTIONS_ROOT
```

## 4. 策略开关

```text
PLATFORM_MCP_ALLOW_STDIO       = false   (stdio disabled)
PLATFORM_MCP_ALLOWED_ORIGINS   = <显式白名单>
PLATFORM_MCP_ALLOW_LOOPBACK    = false   (仅 canary 测试可临时 true)
PLATFORM_MEMORY_TEAM_RUNTIME   = false   (team memory disabled)
```

## 5. Browser / authority

```text
PLATFORM_AUTHORITY            = <platform host>
PLATFORM_DSH_UI_AUTHORITY     = <dsh host>  (dsh --trusted-host)
SESSION_COOKIE_DOMAIN         = <父域>       (跨 authority 共享 sid)
```

## 6. Canary Cohort(allowlist)

- **必须显式 allowlist**(server-side user/tenant id),禁止随机/客户端自报。
- 非 canary 用户继续原路径/原稳定 Runtime。
- 建议:独立 tenant 或专用 internal/test 账号集合。

## 7. Rollback trigger

```text
- launcher preflight FAILED
- Redis fallback to memory
- runtime spawn/restart error rate 超阈值
- WS reconnect failure 持续
- 任一能力 runtime-status ERROR 持续
- 用户可见 blank / message loss
```

触发即执行 Process rollback(+ 快照 restore);详见 `ADR-0006-canary-rollback.md`。

## 8. Release note 必须声明的已知限制

```text
Knowledge retrieval = LEXICAL_V1
Memory retrieval    = LEXICAL_V1
MCP stdio           = DISABLED
MCP tool trial API  = DISABLED_BY_POLICY
Team memory runtime = DISABLED
MCP Resources/Prompts = NOT_SUPPORTED_BY_DSH_0.1.5_RC2
```

## 9. 未决阻塞项(见 final readiness)

```text
ordinary-user workspace provisioning / conversation start = NOT_FUNCTIONAL
REAL_BROWSER_REFRESH_E2E = NOT_EXECUTED
REAL_LLM_*_E2E           = NOT_EXECUTED (browser path)
```

**本配置未激活;Canary 不得启动。**