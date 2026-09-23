# REWORK-02B5 — 最终升级 Gate 决策

> 完成日期:2026-09-17
> 范围:仅“汇总验证 + 最终决策”。**未修改任何源码**,未执行 02C,未升级主环境。
> 依据:`REWORK-02B1`、`REWORK-02B2`、`REWORK-02B3`、`REWORK-02B4` 四份报告 + 本阶段重新实测。
> 环境:`dsh 0.1.5-rc.2` 沙箱(`.tools/dsh-0.1.5-rc.2/`),Node `v24.11.0`,MySQL 8.4.10。

---

## 1. Executive Summary

**最终结论:`GO_TO_02C`**

02B1–02B4 声明的所有核心 Runtime / Session / HTTP / WS / Security Gate 在本次复核中**全部复现为 PASS**:

- Environment:frozen install / build / typecheck / test 重新执行,**exit code 全 0**(39/39 tests)。
- launcher preflight 实测:`dsh launcher ok: node=v24.11.0 dsh=0.1.5-rc.2`。
- launch-token bootstrap 实测:`303 + Set-Cookie: dsh-auth-*`,Location=`/`(不含 token);干净 root `200`(28736 bytes);WS upgrade `ok`。
- F1–F6 源文件 SHA256 与 manifest **逐一 MATCH**,canary 内 V0 原文件哈希不变,V3 后继代存在且字节数与 02B4 一致。
- 测试 API Key:git / 工作区源码 / 文档 / DB audit **0 hits**;launch token 在 gateway 日志 **0 次**;`t_dsh_runtimes` 无 token 列。
- 主 `dsh 0.1.1-rc.2` 环境与主 `var/homes` **未被覆盖**。

**唯一未完成项(必须显式记录,不得伪装为 PASS):**

```text
REAL_BROWSER_REFRESH_E2E = NOT_EXECUTED
→ carry-over:REQUIRED_BEFORE_CANARY_CUTOVER
```

原因:当前测试机无真实浏览器。所有“浏览器刷新/渲染”类验证均以 HTTP RPC + WebSocket 重连做协议层等价验证,已在 02B4 §0/§6 显式声明。

`GO_TO_02C` 仅表示**允许进入 02C 做插件构建与官方契约修复**,**不代表**允许生产切换或全量升级。

---

## 2. Environment Gate — PASS

| 检查项 | 实测证据 | 结果 |
|---|---|---|
| Canary DSH 使用明确 Node executable | 运行中 Runtime `PID 20216` 命令行:`"F:\nvm\nvm\v24.11.0\node.exe" .tools\dsh-0.1.5-rc.2\...\dsh\lib\bin.js ...` | PASS |
| Canary DSH 使用明确 0.1.5-rc.2 CLI entry | 同上 `--profile web ... --trusted-host localhost:8080`;`config.dsh.cliEntry` 来自 `PLATFORM_DSH_CLI_ENTRY` | PASS |
| launcher preflight 工作 | 网关日志:`dsh launcher ok: node=v24.11.0 dsh=0.1.5-rc.2`(PID 4280) | PASS |
| repo `.env` 无平台自有 `DSH_*` | 仅含 `PLATFORM_DSH_*`(HOMES_ROOT / WORKSPACES_ROOT / UI_AUTHORITY);**bare `DSH_*` 键 0 个** | PASS |
| DSH 子进程 cwd ownership 正确 | `supervisor.spawnRuntime` `cwd: homeDir`;运行实例 homes/workspaces 指向 `.tools/fixtures-02b/gateway-homes|gateway-workspaces`;session `cwd` 落在用户 workspace | PASS |
| pnpm 版本已固定 | 根 `package.json` `packageManager: pnpm@11.7.0`;实测 `pnpm --version` → `11.7.0` | PASS |
| `pnpm install --frozen-lockfile` | `Already up to date / Done in 259ms` | **EXIT 0** |
| `pnpm build` | `pnpm -r build` 全部 Done | **EXIT 0** |
| `pnpm typecheck` | `pnpm -r build && pnpm -r typecheck` 全部 Done | **EXIT 0** |
| `pnpm test` | `tests 39 / pass 39 / fail 0` | **EXIT 0** |

补充(环境事实,非缺陷):系统 PATH 上的默认 `node` 为 **v24.0.0**(0.1.5 会在该版本静默退出)。网关与 canary 均显式使用 `F:\nvm\nvm\v24.11.0\node.exe`,证明显式 launcher 固定的必要性。

---

## 3. Launch Token / HTTP / WS Gate — PASS

| 检查项 | 实测证据 | 结果 |
|---|---|---|
| launch token 只存在 Runtime 内存 | `RuntimeInfo.launchToken` 仅内存;子进程 exit 清空;未写任何持久层 | PASS |
| launch token 不入 DB | `t_dsh_runtimes` 无 token 列(`information_schema` 查询 `column_name LIKE '%token%'` = **0**);audit `payload LIKE '%token=%'` = **0** | PASS |
| launch token 不进入浏览器 URL | 实测 bootstrap `Location: /`;`locationHasToken=false` | PASS |
| launch token 不进入普通日志 | gateway 日志中 `token` 出现次数 = **0** | PASS |
| root bootstrap 303 + Set-Cookie | 实测 `bootstrapStatus=303`,`dshCookieNames=["dsh-auth-..."]` | PASS |
| clean root GET 200 | 实测 `cleanRootStatus=200`,`cleanRootBytes=28736`,`isHtml=true` | PASS |
| HTTP API | 实测 `GET /api/health` → `{"ok":true,"db":true}`;`session/list` → 200 `ok=true` | PASS |
| WebSocket 101 | 实测 WS upgrade `{ok:true, ms:4}`;02B4 `ws-test.json` upgrade ok | PASS |
| WebSocket stream | `ws-test.json`:`followStream` snapshot + 15 event + 12 assistant-stream;`controlStream` item×1 | PASS |
| refresh/reconnect | `ws-test.json`:`refreshReconnect` snapshot ok | PASS |
| Runtime restart reconnect | `post-restart.json`:`ws` snapshot=true, events=1, ok=true | PASS |
| 用户 A/B Runtime 隔离 | 02B2 §7 独立 PID/端口;02B4 迁移与新建会话均在 canary 独立 DSH_HOME | PASS |

本次 live smoke(经运行中网关 PID 4280 → dsh 0.1.5 runtime PID 20216):
`login=200, bootstrap=303, cleanRoot=200(28736B), WS upgrade ok(4ms), session/list=200 ok count=3`。
`session/page` 以 `throughSeq` 超界返回官方语义 `past cursor 17`(非缺陷;真实 cursor 读取正常)。

---

## 4. V0 → V3 Migration Gate — PASS

源不可变性(canary 内 V0 与 `source-backup/` 逐一比对,均 `IsReadOnly=True`):

| Fixture | bytes | SHA256(canary V0 == source-backup == manifest) | 结果 |
|---|---|---|---|
| F1 | 27826 | `D95A2015...170E17` | MATCH |
| F2 | 39779 | `02BEFB7D...C397ED` | MATCH |
| F3 | 20297 | `3E9C438D...60ECBF` | MATCH |
| F4 | 29910 | `5029D16E...892D88` | MATCH |
| F5 | 27361 | `991DF2DA...912A9` | MATCH |
| F6 | 16352 | `13A6984F...000B4` | MATCH |

V3 后继代存在且字节数与 02B4 §2 一致(F1 38784 / F2 30627 / F3 29754 / F4 29516 / F5 28462 / F6 28575)。

逐项(源自 `verify-fixtures.json` / `post-restart.json`,与 02B4 §3 一致):

| Fixture | V0 immutable | V3 generated | open | history | continue | restart | re-open | 语义保留 |
|---|---|---|---|---|---|---|---|---|
| F1 短多轮 | PASS | PASS | PASS | PASS | PASS(`CONT-F1`) | PASS | PASS | PASS |
| F2 长多轮 | PASS | PASS | PASS | PASS | PASS(`CONT-F2`) | PASS | PASS | PASS |
| F3 cancel | PASS | PASS | PASS | PASS | PASS(`CONT-F3`) | PASS | PASS | PASS(`turn/end aborted/user` 保留) |
| F4 steering | PASS | PASS | PASS | PASS | PASS(`CONT-F4`) | PASS | PASS | PASS(`STEERED-OK` 保留) |
| F5 tool | PASS | PASS | PASS | PASS | PASS(`CONT-F5`) | PASS | PASS | PASS(`tool/call`+`tool/result` 1:1) |
| F6 real historical | PASS | PASS | PASS | PASS | PASS(`CONT-F6`) | PASS | PASS | PASS(中文内容保留) |

`post-restart.json`:F1–F6 全部 `listed=true, running=false, cursorBefore==cursorAfterRestart, continuePersisted/resumeOk/reOpenOk=true`。

---

## 5. New V3 Session Gate — PASS

| 会话 | sessionId | 验证 | 结果 |
|---|---|---|---|
| N1 普通多轮 | `session-971e64a1-...` | 3 turns `N1-A/B/C` 持久化;restart 后 3 marker 全恢复 | PASS |
| N2 cancel | `session-c3457565-...` | `session/cancel` `{accepted:true}`;`turn/end {aborted, user}`;`running=false` | PASS |
| N3 steering | `session-4db64c60-...` | 生成中 `mode:'steer'` accepted;marker `STEER-N3` 持久化 | PASS |
| N4 tool | `session-2d285f00-...` | `tool/call`×1 + `tool/result`×1;读到 `CMCC_F5_TEST_TOKEN=517303` | PASS |

Runtime restart 后(`post-restart.json.newSessions`):N1–N4 全部 `listed=true, running=false, recoveryOk=true`,marker 保留。

---

## 6. Active-turn Gate — PASS(5/5)

`active-turn.json`:`overallPass=true`,5 个 run 全部 `blankSeenDuringActive=false`、`streamSeen=true`、`finalBlank=false`、`finalAssistantChars` 非空(1937 / 1750 / 2271 / 2924 / 2226)。

| run | sessionId(JSON) | active 期间 blank | stream | 完成后 blank | 最终 assistant | 结果 |
|---|---|---|---|---|---|---|
| 1 | `session-180cb172-...` | 无 | 有 | false | 非空 | PASS |
| 2 | `session-5c69ec8d-...` | 无 | 有 | false | 非空 | PASS |
| 3 | `session-b52400b1-...` | 无 | 有 | false | 非空 | PASS |
| 4 | `session-e5d4be27-...` | 无 | 有 | false | 非空 | PASS |
| 5 | `session-a2504b1d-...` | 无 | 有 | false | 非空 | PASS |

无持续 blank、无消息丢失、无 stuck turn。

> **记录一处文档偏差(不影响判定):** 02B4 §6 表格的“run 序号 ↔ sessionId ↔ active 时长”映射与 `active-turn.json` 的实际数组顺序发生轮转(例如报告 run 1=`b52400b1`/95s,JSON 中 `b52400b1` 实为第 3 个、95s)。5 个会话本身全部存在且全部 PASS,仅为报告记账顺序不一致。

**未执行项:**

```text
REAL_BROWSER_REFRESH_E2E = NOT_EXECUTED
```

- 原因:测试机无真实浏览器。
- 替代:HTTP `session/list` + `session/page`(检查 running/blank/stream)+ WS 重连。
- carry-over:**REQUIRED_BEFORE_CANARY_CUTOVER**。不得写成“真实浏览器 E2E 已完成”。

---

## 7. Security Gate — PASS

| 检查项 | 方法 | 结果 |
|---|---|---|
| `PLATFORM_TEST_DEEPSEEK_API_KEY` 不进入 Git | `git grep -F` 全跟踪文件 | **0 hits** |
| API Key 不进入工作区源码/文档 | apps/packages/docs/db + 根 `.md/.json/.sql/.yaml/.ps1` 扫描 | **0 hits** |
| API Key 不进入日志 | gateway/canary 日志扫描(02B4)+ 本次 live 复核 | **0 hits** |
| API Key 不进入 DB | `t_dsh_audit_events.payload LIKE '%sk-%'` | **0** |
| API Key 不进入 Markdown 报告 | 本报告及 02B1–02B4 扫描 | **0 hits** |
| API Key 只注入 Canary / qualification Runtime | `supervisor.childEnv`:`canaryRoot` 非空且 `isUnderCanaryRoot(homeDir)` 才注入 | PASS |
| 普通用户 Runtime 不获得测试 Key | `PLATFORM_DSH_CANARY_ROOT` 留空即默认拒绝;循环剔除所有 `PLATFORM_*` 源变量名 | PASS |
| launch token 不入 DB | `t_dsh_runtimes` 无 token 列 | PASS |
| source-backup 未被修改 | 6 文件 `IsReadOnly=True`,SHA256 与 manifest 全 MATCH | PASS |
| 主 `0.1.1-rc.2` 环境未被覆盖 | 全局 `dsh --version` → `0.1.1-rc.2`;主 `var/homes` 最新写入 2026-09-17 11:31(早于 02B4 14:32–15:48) | PASS |
| `.env` / `.tools/` 未被 Git 跟踪 | `git check-ignore` 命中 `.gitignore`;`git ls-files` 无匹配 | PASS |

**本报告不含任何 Secret 实际值。**

---

## 8. Regression Test Results

| 命令 | 结果 |
|---|---|
| `pnpm install --frozen-lockfile` | **EXIT 0**(`Already up to date`) |
| `pnpm build` | **EXIT 0** |
| `pnpm typecheck` | **EXIT 0** |
| `pnpm test` | **EXIT 0**(39 tests / 39 pass / 0 fail) |
| live 0.1.5 smoke(launcher preflight + runtime start + bootstrap + HTTP + WS + list/open) | **PASS** |

live smoke 明细:launcher `node=v24.11.0 dsh=0.1.5-rc.2`;runtime `PID 20216`;bootstrap `303`;clean root `200`(28736B);WS upgrade `ok 4ms`;`session/list` `200 ok count=3`。

---

## 9. Remaining Deviations / Carry-over Risks

1. **REAL_BROWSER_REFRESH_E2E = NOT_EXECUTED**(阻塞项,进入 Canary 前必须补做)。
   本机无浏览器,刷新类验证以 HTTP/WS 协议层等价替代。
2. **active-turn 报告记账偏差**:02B4 §6 的 run↔sessionId↔时长映射与原始 `active-turn.json` 顺序轮转;5/5 实质 PASS,建议后续报告直接引用 JSON 原始顺序。
3. **`gateway-smoke.cjs` 脚本缺陷(测试工具,非平台缺陷)**:`session/list` 请求声明了 `content-length` 却未发送 body,导致 500(网关日志 `SocketError: other side closed`)。以正确客户端复测得 `200 ok`。
4. **默认 `node` v24.0.0**:PATH 默认版本对 0.1.5 不安全;生产/Canary 必须保持显式 `PLATFORM_DSH_NODE_BIN` + `PLATFORM_DSH_CLI_ENTRY`。
5. **`dump.rdb` 未 gitignore**(仓库根,untracked)。非 Secret,但建议清理或加入 `.gitignore`。
6. **测试 Key 轮换**:该测试 Key 曾以明文出现在会话中,建议测试完成后 rotate。
7. **一次性 launch token 可被多次交换**(02B2 §10 已知):`withBootstrapLock` 已串行化;官方行为,非缺陷。
8. **旧 dsh cookie 跨 restart 有效**(HMAC secret 持久):官方设计,非缺陷。

---

## 10. Modified Source Files

说明:仓库仅有 2 个 scaffold commit,02B1–02B4 的改动**尚未提交**,因此 Git 无法按阶段 diff。以下按“阶段归属 + 当前 Git 状态”分类列出。

### SOURCE CHANGE(平台源码)

| 文件 | 归属 | Git 状态 |
|---|---|---|
| `apps/gateway/src/config.ts` | 02B1(`PLATFORM_DSH_*` 重命名 + `nodeBin/cliEntry`)、02B4(`canaryRoot`) | untracked |
| `apps/gateway/src/supervisor.ts` | 02B1(显式 launcher + `probeDshLauncher`)、02B2(launchToken/bootstrap lock/`redactToken`)、02B3(测试 Key 映射)、02B4(`isUnderCanaryRoot` 隔离) | modified |
| `apps/gateway/src/index.ts` | 02B1(`onReady` launcher preflight) | modified |
| `apps/gateway/src/proxy.ts` | 02B2(launch-token bootstrap / 303+Set-Cookie 转发 / WS) | untracked |
| `package.json` | 02B1(`packageManager: pnpm@11.7.0`、`engines.node >=22.19.0`、test 脚本) | modified |
| `.env.example` | 02B1(重命名 + launcher 项) | modified |
| `.gitignore` | 02B1(`.tools/`) | modified |
| `README.md` | 02B1(环境变量引用) | modified |
| `pnpm-lock.yaml` | 02B1(pnpm 11.7.0 补全 importer) | modified |

### DOCUMENTATION

- `docs/implementation/REWORK-02B1-runtime-env-lockfile.md`(untracked)
- `docs/implementation/REWORK-02B2-launch-token-bootstrap.md`(untracked)
- `docs/implementation/REWORK-02B3-credential-v0-fixtures.md`(untracked)
- `docs/implementation/REWORK-02B4-final-qualification.md`(untracked)
- `docs/implementation/adr/ADR-0001-launch-token-bootstrap-authority.md`(untracked,02B2)
- `docs/implementation/REWORK-02B5-upgrade-gate.md`(本文件,新建)

### TEST / QUALIFICATION ARTIFACT(gitignored)

- `.tools/fixtures-02b/`:canary-home、gateway-homes、gateway-workspaces、legacy-home、legacy-workspace、migration-copy、source-backup、`FIXTURE-MANIFEST.csv`、各 `*.cjs/*.ps1/*.json`。
- `.tools/dsh-0.1.5-rc.2/`:0.1.5 沙箱。

### GITIGNORED LOCAL ARTIFACT

- `.env`(含 `PLATFORM_TEST_DEEPSEEK_API_KEY`,**未被跟踪**;本报告未输出其内容)。
- `.tools/`、`var/`、`dist/`、`node_modules/`。
- `dump.rdb`(untracked,**未** gitignore,见 §9.5)。

### 非 02B1–02B4 但当前工作区存在的 untracked 源码/文档

`apps/gateway/src/{audit.ts,auth/,fastify.d.ts,platform.ts,profile-patch.ts,repositories/,routes/,services/,session-sync.ts,tools/}`、`apps/gateway/tests/`、`apps/portal/src/*`、`packages/{connector,knowledge-base,skill-plaza}/`、`docs/operations/`、`cmcc-dsh-*-prompts/`、`start.ps1`、`stop.ps1` 等 —— 属更早/其它阶段产物,非 02B1–02B4 引入。

**本阶段未新增或修改任何平台源码。**

---

## 11. Final Decision

```text
GO_TO_02C
```

判定依据(全部满足):

- V0→V3 语义迁移 PASS(F1–F6)
- 新 V3 Session PASS(N1–N4)
- HTTP PASS
- WebSocket PASS(upgrade / stream / reconnect / restart reconnect)
- launch-token bootstrap PASS
- Runtime restart restore PASS
- tenant/user isolation PASS
- Secret isolation PASS
- frozen install / build / typecheck / test 全 EXIT 0

同时强制记录:

```text
REAL_BROWSER_REFRESH_E2E = REQUIRED_BEFORE_CANARY_CUTOVER
```

即:**允许进入 02C 做插件构建与官方契约修复;不代表允许生产切换或全量升级。**

下一步按既有 `02C-插件构建与契约修复.md` 执行,**不得**直接跳到 Skill / Knowledge / MCP / Memory / UI。
