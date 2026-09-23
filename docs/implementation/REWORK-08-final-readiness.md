# REWORK-08 — FINAL E2E / CANARY READINESS GATE(结果报告)

> 完成日期:2026-09-18
> 前置:Phase 07 = `GO_TO_FINAL_E2E`
> 环境:Node `v24.11.0`(nvm) · DSH `0.1.5-rc.2` · 真实 MySQL 8.4 + Redis 5.0.14 · 真实 Microsoft Edge(Playwright 1.63)
> 自动化:`scripts/final-e2e/*.mjs`

---

## Final Decision

```text
BLOCKED
```

硬项未满足:普通用户无法在浏览器中开始对话(workspace provisioning / conversation start 未闭环),导致 `REAL_BROWSER_REFRESH_E2E` 与全部 `REAL_LLM_*_E2E` 无法执行;且 V3 之后无对真实用户可执行的回滚策略。

---

## 1. Browser environment

| 项 | 值 |
|----|----|
| Browser | Microsoft Edge(系统安装),Playwright `channel: msedge` |
| Platform | `localhost:5173`(Vite portal,代理 `/api`,`/auth` → Gateway) |
| DSH UI | `localhost:8080`(Gateway 按 Host 反代 per-user dsh) |
| Node | `v24.11.0` — `dsh launcher ok: node=v24.11.0 dsh=0.1.5-rc.2` |
| Redis | `redis://127.0.0.1:6379` — Gateway `session=redis`(无 memory fallback) |
| MySQL | 运行;migration 007 已应用 |

## 2. Login / Logout

- B1 未登录 `http://localhost:8080/` → 302 → `http://localhost:5173/login`;URL 无 launch token。
- B2 真实 Edge 登录 admin → 进入 DSH Web Shell;品牌「中国移动 · 数智智能体平台」。
- Logout:平台 session 失效;旧 `dsh-auth-*` cookie 不能绕过 Platform Auth。
- **PASS**

## 3. Four-panel navigation

| Panel | main 内容标记 | 结果 |
|-------|---------------|------|
| 技能广场 | 新建技能 | PASS |
| 知识中心 | 新建知识库 | PASS |
| MCP 服务 | 新建连接器 | PASS |
| 我的记忆 | 平台记忆库 | PASS |

无整页跳转 / React crash / 白屏;`/api/*` 0 失败;无 iframe;无 Portal Dashboard 主壳。

**PASS**

## 4. REAL_BROWSER_REFRESH_E2E

```text
REAL_BROWSER_REFRESH_E2E = NOT_EXECUTED
```

根因(真实产品 gap,非自动化缺陷):

- 平台未为普通用户预置 DSH workspace(`t_dsh_workspaces` 为空)。
- `platform-identity` 不注册/同步 workspace;`sdk-driver` 为 `DEFERRED` 桩(全 TODO)。
- DSH workspace picker「添加工作区」走 **native 目录选择器**,Web Shell 中不可用。

→ 普通用户停在「选择一个工作区开始」,**无法发起对话 → 无法 streaming → 无法 refresh**。

**BLOCKED**

## 5. Runtime restart browser recovery

浏览器保持打开时的恢复依赖活动会话 → **NOT_EXECUTED(随 §4)**。
HTTP 级 restart/投影恢复在 Phase 06/07 已 PASS。

## 6. A/B browser isolation

- 独立 Browser Context 登录 A/B,不同 `sid`/Runtime 已验证。
- 会话级浏览器隔离 **NOT_EXECUTED(随 §4)**;API/投影级隔离 PASS。

## 7. REAL_LLM_SKILL_E2E

```text
REAL_LLM_SKILL_E2E = NOT_EXECUTED
```

- 测试模型 credential **有效**(0.1.5 headless 真实调用返回 `OK`)。
- 但浏览器对话路径被 §4 阻塞,无法在 UI 内创建/发布/安装 Skill 并让模型调用。
- 契约/Registry 级验证见 Phase 04。

## 8. REAL_LLM_KNOWLEDGE_E2E

```text
REAL_LLM_KNOWLEDGE_E2E = NOT_EXECUTED
```

同 §7(浏览器路径阻塞);ingestion/检索/工具链在 Phase 05 已真实验证。

## 9. REAL_LLM_MCP_E2E

```text
REAL_LLM_MCP_E2E = NOT_EXECUTED
```

Phase 06 已用真实 dsh Runtime + 官方 mcp-client + 真实 fixture 验证 `mcp__fixture__cmcc_marker` → `CMCC_MCP_FIXTURE_06`;浏览器模型路径被 §4 阻塞。

## 10. REAL_LLM_MEMORY_E2E

```text
REAL_LLM_MEMORY_E2E = NOT_EXECUTED
```

Phase 07 已用真实 Runtime + 真实 completed-turn 提取 + 真实 recall 注入验证跨 Session 召回;浏览器模型路径被 §4 阻塞。

## 11. revoke / unmount / uninstall / forget

- Phase 04–07 已在 HTTP/投影/Runtime 级验证撤销后能力消失(deny-first)。
- 浏览器用户级验证受 §4 阻塞 → **NOT_EXECUTED(浏览器层)**。

## 12. Cross-capability Session E2E

**NOT_EXECUTED**(浏览器对话阻塞)。

## 13. Legacy Session Browser E2E

**NOT_EXECUTED**(无活动会话;真实用户 home 未触碰)。

## 14. API routing collision gate

**PASS**(`REWORK-08-api-routing-gate.md`):平台 prefix 不误捕 DSH `/api/session/*`、`/api/remote`;平台 API 正确命中;未知明确 401/404。

## 15. Secret leakage scan

**PASS**(`REWORK-08-security-e2e.md`):git tracked 0 命中;生成 patch / DSH_HOME / projection / logs 0 明文 secret;测试 key 仅在 gitignore 的 `.env`。

## 16. Browser cookie / storage gate

**PASS**:`sid`/`device_id`/`dsh-auth-*` HttpOnly;`csrf_token` 双提交;URL 无 launch token;local/sessionStorage 为空。

## 17. Redis / MySQL readiness

**PASS**:Redis `PONG` + Gateway `session=redis`(无 fallback);MySQL 运行 + migration 应用。

## 18. Idle cleanup / restart

**PASS**(`idle.mjs`):idle reaper drain → 再次 ensure 恢复(新 runtimeId,ready)。

## 19. Concurrency smoke

**PASS**(`concurrency.mjs`):5 用户并发 login+API 全 200(114ms);2 用户并发 ensureRuntime 不同 runtimeId、ready、0 错误。
真实模型请求部分受 §4 阻塞。

## 20. Rollback reality test

**PASS(实测行为已记录)** → `ADR-0006-canary-rollback.md`:

```text
NO_IN_PLACE_DOWNGRADE_AFTER_V3_WRITES
```

0.1.5 写 `session.v3.jsonl.zstd`;0.1.1 写 `session.jsonl.zstd`、无 `--resume`、无 format 迁移 → 0.1.1 不可读 V3。

## 21. Backup / restore rehearsal

**PASS**:`mysqldump` → restore 隔离库 exit 0;27 表 / 2 users / 17 memory rows 可读。
坑:PowerShell `>` 重定向写 UTF-16 → 必须 `Start-Process -RedirectStandardOutput` 或 `--binary-mode`。

## 22. Canary cohort / config

`REWORK-08-canary-config.md` 已生成(DRAFT,未激活);cohort 必须显式 allowlist。
**可执行回滚策略:对 canary 专用账号 + 快照可执行;对真实普通用户当前不可执行。**

## 23. Observability

关键事件可定位(login/runtime spawn/launcher/bootstrap/各能力 runtime-status),日志无 secret。**SUFFICIENT(不含 APM)**。

## 24. Known limitations

```text
Knowledge retrieval = LEXICAL_V1
Memory retrieval    = LEXICAL_V1
MCP stdio           = DISABLED
MCP tool trial API  = DISABLED_BY_POLICY
Team memory runtime = DISABLED
MCP Resources/Prompts = NOT_SUPPORTED_BY_DSH_0.1.5_RC2
```

## 25. Regression

| 命令 | 结果 |
|------|------|
| `pnpm install --frozen-lockfile` | EXIT 0 |
| `pnpm -r build` | EXIT 0 |
| `pnpm -r typecheck` | EXIT 0 |
| `pnpm -r test` | EXIT 0(**103 pass**) |

launcher preflight PASS;Runtime start / bootstrap / HTTP / WS / Session list/open / restart / idle / `__DSH_BOOT__` PASS(HTTP 级)。
Skill/Knowledge/MCP/Memory Runtime 无回归。

## 26. Modified Files

### 新增

| 文件 | 说明 |
|------|------|
| `scripts/final-e2e/stack.mjs` | 真实 stack bring-up(Node 24.11 + Redis + portal) |
| `scripts/final-e2e/{explore,panels,panels-verify,chat-probe,session-probe,ws-probe,add-ws-probe}.mjs` | 浏览器探测 |
| `scripts/final-e2e/{api-routing,secret-scan,security-browser,concurrency,idle}.mjs` | 非浏览器 gate |
| `scripts/browser-smoke.mjs` | Playwright/Edge smoke |
| `docs/implementation/REWORK-08-browser-e2e.md` | 浏览器 E2E |
| `docs/implementation/REWORK-08-api-routing-gate.md` | 路由 gate |
| `docs/implementation/REWORK-08-security-e2e.md` | 安全 E2E |
| `docs/implementation/REWORK-08-operations-readiness.md` | 运维就绪 |
| `docs/implementation/ADR-0006-canary-rollback.md` | 回滚策略 |
| `docs/implementation/REWORK-08-canary-config.md` | Canary 配置(DRAFT) |
| `docs/implementation/REWORK-08-final-readiness.md` | 本文件 |

### 修改

| 文件 | 变更 |
|------|------|
| `package.json` / `pnpm-lock.yaml` | +`playwright`(devDep,浏览器自动化) |

> 本阶段**未修改任何业务代码/安全边界**;仅新增 E2E 自动化、文档与 Playwright 依赖。
> 未触碰真实用户 DSH_HOME;未删除 0.1.1 fallback;未启动 Canary。

---

## 27. Final Decision

```text
BLOCKED
```

### GO_TO_CANARY 检查

| 硬项 | 结果 |
|------|------|
| REAL_BROWSER_REFRESH_E2E = PASS | ❌ NOT_EXECUTED |
| login/logout real browser | ✅ |
| four panels real browser | ✅ |
| Session → panel → Session | ⚠️ 部分(无法创建会话) |
| browser Runtime restart recovery | ❌ NOT_EXECUTED |
| A/B browser isolation | ⚠️ 部分 |
| REAL_LLM_SKILL_E2E | ❌ NOT_EXECUTED |
| REAL_LLM_KNOWLEDGE_E2E | ❌ NOT_EXECUTED |
| REAL_LLM_MCP_E2E | ❌ NOT_EXECUTED |
| REAL_LLM_MEMORY_E2E | ❌ NOT_EXECUTED |
| uninstall/unmount/revoke/forget user-level deny | ⚠️ 浏览器层未执行 |
| legacy migrated Session browser E2E | ❌ NOT_EXECUTED |
| API namespace collision gate | ✅ |
| Secret final scan | ✅ |
| Cookie/storage gate | ✅ |
| Redis = READY | ✅ |
| MySQL = READY | ✅ |
| explicit Node/CLI launcher | ✅ |
| idle cleanup/restart | ✅ |
| 5-user concurrency smoke | ⚠️ API PASS;模型请求阻塞 |
| rollback empirically documented | ✅ |
| executable rollback strategy | ❌ 对真实用户不可执行 |
| backup/restore rehearsal | ✅ |
| Canary allowlist/config ready | ⚠️ DRAFT |
| observability | ✅ |
| install/build/typecheck/test | ✅ 103 pass |
| HTTP/WS/bootstrap/restart | ✅ |
| Skill/Knowledge/MCP/Memory no regression | ✅ |

### 阻塞项(必须修复后才能 Canary)

1. **Workspace provisioning / conversation start**:平台必须为普通用户提供可用的默认 workspace(或修复 Web 目录选择器),使 DSH Shell 能开始对话。
2. **REAL_BROWSER_REFRESH_E2E ×5**:依赖 (1)。
3. **REAL_LLM_*_E2E ×4**:依赖 (1)。
4. **可执行回滚策略(真实用户)**:V3 之后不可原地降级;需明确快照/restore 或 forward-fix 风险接受。

### 下一阶段

```text
FINAL_E2E / CANARY READINESS GATE(修复阻塞项后重跑)
```

**不得自动启动真实 Canary。等待人工确认。**