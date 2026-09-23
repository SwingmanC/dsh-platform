# REWORK-02B — Session Qualification Report

> 测试日期:2026-09-16
> 目标版本:`@deepseek-ai/dsh@0.1.5-rc.2`(tag `dsh-v0.1.5-rc.2`)
> 沙箱位置:`.tools/dsh-0.1.5-rc.2/`(独立,不覆盖全局)
> 结果枚举:PASS / FAIL / NOT_APPLICABLE / BLOCKED

---

## 决策:BLOCKED

**保留 0.1.1-rc.2 主环境。** 沙箱安装与运行时启动成功,全局面板 API 确认存在;但 Session 迁移的**完成定义无法满足**(需要打开会话/发消息,而本机无 API key),且发现 2 个必须先解决的破坏性变更(Node 版本要求、`.env` DSH_* 拒绝)。因此不得进入 02C。

---

## 1. 固定版本与独立安装

| 项 | 结果 | 证据 |
|---|---|---|
| 使用固定版本(非 latest/next/master/0.1.6) | **PASS** | `.tools/dsh-0.1.5-rc.2/package.json` 钉 `0.1.5-rc.2` |
| 独立安装(不覆盖全局) | **PASS** | `npm install` 得 584 包;全局仍 `0.1.1-rc.2` |
| 明确 executable | **PASS** | `node .tools/dsh-0.1.5-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js` |
| 沙箱 `dsh --version` | **PASS** | `0.1.5-rc.2` |
| 全局 `dsh --version` 未变 | **PASS** | `0.1.1-rc.2` |

### 1.1 关键阻塞:Node 版本要求(新发现)

- 0.1.5-rc.2 `lib/bin.js` 末行为 `if (import.meta.main) await runCli();`
- `import.meta.main` 在 **Node 24.0.0 上为 `undefined`**(实测),导致 CLI **静默退出(exit 0,无任何输出)**。
- 本机可用 Node:仅 `24.0.0` 与 `23.10.0`,**均不支持**。
- 官方 monorepo `engines: ^22.19.0 || >=24.0.0` **与 `import.meta.main` 的实际要求不一致**。
- 解决:通过 nvm 安装 `24.11.0`,**用绝对路径显式调用**(不 `nvm use`,避免影响全局 dsh)。
- `node v24.11.0` 下 `import.meta.main === true`,沙箱 CLI 正常。

**影响:** 平台 Supervisor 用 `config.dsh.bin='dsh'`(PATH 解析)。升级后若运行 Node 仍为 24.0.0,所有 Runtime 将静默不启动。必须先升级 Node 或改用显式 node 路径。

## 2. 破坏性变更:`.env` 拒绝 DSH_*

- 0.1.5-rc.2 `loadLayeredEnv` 读取 **cwd 下的 `.env`**,并**拒绝**其中的 `DSH_*` 变量:
  ```
  Error: dsh: <repo>/.env sets "DSH_HOMES_ROOT", which only the launching environment may set ... export DSH_HOMES_ROOT instead of putting it in a .env file
  ```
- 平台仓库根 `.env` 含 `DSH_HOMES_ROOT`、`DSH_WORKSPACES_ROOT`、`DSH_BIN`、`DSH_UI_AUTHORITY`。
- 从中性 cwd 启动即成功 → 说明**仅当 dsh 的 cwd 为仓库根时失败**。
- 平台 Supervisor 以 `cwd=homeDir` 启动,理论上规避;但**必须实测确认**(本次未测,因需完整网关链路)。

## 3. 启动行差异:launch token

- 0.1.1-rc.2:`dsh web: http://127.0.0.1:<port>`(**无 token**)
- 0.1.5-rc.2:`dsh web: http://127.0.0.1:<port>/?token=<43字符>`(**有 token**)
- 实测 `GET /?token=...` → **303 → 200**,并下发 HttpOnly cookie `dsh-auth-<随机后缀>`。
- 结论:0.1.5 **恢复**了设计文档 §3.2 的 launch-token 模型;平台当前**未实现** token 交换。

## 4. 全局面板 API(实测确认)

| 项 | 结果 | 证据 |
|---|---|---|
| `sidebar.panellist` | **PASS** | `dsh-client-ui-sidebar/lib/client.js` 含该字符串 |
| `main.conversation` | **PASS** | `dsh-client-ui-conversation/lib/client.js` |
| `selectPanel` | **PASS** | `dsh-client-ui-layout`、`ui-sidebar`、`ui-workspace` |
| `__DSH_BOOT__` 含 ui-layout/ui-sidebar | **PASS** | `GET /?token=...` HTML 含二者 |

## 5. B6(pnpm 12.4.1 vs upstream 11.7.0)

| 验证项 | 结果 | 说明 |
|---|---|---|
| `pnpm install --frozen-lockfile` | **FAIL** | `ERR_PNPM_PACKAGE_MANAGER_NO_IMPORTER`:`packages/connector` 无 importer |
| `pnpm install --lockfile-only` | **FAIL(不修复)** | 输出 "Already up to date",不补 importer |
| `pnpm install`(非 frozen) | PASS(但同样不补) | — |
| `pnpm build` | **PASS** | EXIT 0 |
| `pnpm typecheck` | **PASS** | EXIT 0 |
| `pnpm test`(gateway) | **PASS** | 39/39 |
| 独立 dsh 安装 | **PASS** | 584 包 |
| `dsh --version` | **PASS** | 0.1.5-rc.2(需 Node 24.11) |
| `dsh web` 启动 | **PASS** | 见 §7 |

**根因:** `packages/{connector,knowledge-base,skill-plaza}` 是**零依赖**的 workspace 包。pnpm 12.4.1 不为零依赖包写入 importer,但 `--frozen-lockfile` 又要求存在。`pnpm list -r` 能识别这 3 个包,证明不是 workspace 配置问题。

**B6 判定:FAIL(未解除)。** 明确锁定方案:为 3 个 UI 包各加一个 `devDependencies`(如 `typescript`)使其产生 importer,或改用 pnpm 11.7.0,或接受 `--frozen-lockfile` 不可用。

## 6. Session Fixtures

| Fixture | 期望 | 结果 | 说明 |
|---|---|---|---|
| F1 短 Session | 生成/存在 | **NOT_APPLICABLE** | 无 API key,无法生成 |
| F2 长 Session | 生成/存在 | **NOT_APPLICABLE** | 同上 |
| F3 取消/中断 Session | 生成/存在 | **NOT_APPLICABLE** | 同上 |
| F4 user steering Session | 可生成时 | **NOT_APPLICABLE** | 同上 |
| F5 subagent 历史 Session | 存在时 | **NOT_APPLICABLE** | 全库 0 个 subagent 事件 |
| F6 脱敏真实历史 Session 副本 | 存在时 | **PARTIAL** | 全库唯一 1 个有内容的会话(16KB,1 turn) |

### 6.1 会话现状实测(全量扫描 2120 个会话)

| 指标 | 值 |
|---|---|
| 会话文件总数 | 2120 |
| 解压成功 | 2120(0 失败) |
| 格式版本 | **全部 `version: 0`(V0)** |
| 总 turn 数 | **1** |
| user/message 总数 | 2 |
| assistant/message 总数 | 1 |
| tool/result 总数 | **0** |
| 最大会话 | 16352B(11 个 zstd 帧,解压 42090B,27 事件) |

**结论:平台从未产生真实对话历史。** 2119 个会话为空壳(仅 header),唯一有内容的是 1 个 V0 会话(1 个完整 turn)。

### 6.2 只读备份

- 唯一实质会话已只读备份至 `.tools/fixtures-02b/source-backup/F6-session.jsonl.zstd`
- 源 SHA256 = 备份 SHA256 = `13A6984F...4BD000B4`

## 7. 三个专门风险

### A. user steering / missing turn-end
**PASS** — 全量扫描 2120 会话:`turn/start` 与 `turn/end` **完全平衡,0 处缺失**。
(注:因只有 1 个 turn,样本量极小,结论强度有限。)

### B. old subagent descriptor
**NOT_APPLICABLE** — 全量扫描:`subagent/descriptor` 事件 **0 个**,任何 `subagent/*` 事件 **0 个**。

### C. active-turn blank UI
**BLOCKED** — 需要"发一个持续足够长的请求"并"turn active 时刷新"。本机**无 DEEPSEEK_API_KEY**,无法产生 active turn。未执行 5 次重复。

## 8. Migration 完成定义

| 步骤 | 结果 | 说明 |
|---|---|---|
| list | **BLOCKED** | 需 UI/API 触发读取 |
| open | **BLOCKED** | 需 Typert RPC 或浏览器 |
| 历史消息完整 | **BLOCKED** | — |
| 继续发消息 | **BLOCKED** | 需 API key |
| refresh | **BLOCKED** | 需浏览器 |
| resume | **BLOCKED** | 需 API key |
| restart 后 restore | **BLOCKED** | 需先 open |

**已验证的前置事实:**
- 0.1.5-rc.2 含完整迁移链:`dsh-session-format-v0-to-v1` + `dsh-session-format-v1-to-v2` + `dsh-session-format-v2-to-v3` → **V0 会话受支持**。
- 启动 dsh web **不触发迁移**(迁移在读取时惰性发生):副本启动后 2120 文件数不变、最大会话 hash 不变、无新文件。
- 迁移需通过 `Session.get` / `session.getSnapshot`(Typert Remote)或浏览器打开触发;无头环境下未完成。

## 9. 文件级验证

| 项 | 结果 |
|---|---|
| 源 V0 最大会话 SHA256(测试前) | `13A6984F...4BD000B4` |
| 源 V0 最大会话 SHA256(测试后) | `13A6984F...4BD000B4` |
| 源会话总数(测试前/后) | 2120 / 2120 |
| **源文件是否保持不变** | **PASS(完全未变)** |
| 副本新 V3 路径 | 未产生(迁移未触发) |
| 用户消息数 / assistant 消息数 | 2 / 1 |
| tool result 是否保留 | 无 tool result |

## 10. 新 V3 Session

**BLOCKED** — 需在 0.1.5 下新建会话、多轮、取消、steering、执行 tool,全部依赖 API key。

## 11. Runtime 稳定性

| 项 | 结果 | 证据 |
|---|---|---|
| start | **PASS** | `dsh web: http://127.0.0.1:3094/?token=...` |
| stop | **PASS** | 端口释放 |
| restart | **PASS** | 端口 3093 重新监听 |
| idle reaper | **NOT_APPLICABLE** | 属平台 Supervisor,非 dsh |
| HTTP | **PASS** | `GET /?token=...` → 200, len=27660 |
| WebSocket | **PARTIAL** | 端点定位为 `/api/remote`;无头握手未完成(需浏览器/精确子协议) |
| 连续多轮交互 smoke | **BLOCKED** | 需 API key |

## 12. 环境事实

| 项 | 值 |
|---|---|
| 本机 Node(默认) | `v24.0.0`(不支持 `import.meta.main`) |
| 本机 Node(沙箱用) | `v24.11.0`(nvm 安装,未切换活动版本) |
| 本机 pnpm | `12.4.1` |
| upstream packageManager | `pnpm@11.7.0` |
| upstream engines.node | `^22.19.0 || >=24.0.0` |
| 全局 dsh | `0.1.1-rc.2`(未变) |
| 沙箱 dsh | `0.1.5-rc.2` |

---

## Gate 对照

| 条件 | 结果 |
|---|---|
| 项目关键历史 Session 可恢复 | **BLOCKED**(无真实历史;迁移未触发) |
| 新 V3 Session 可恢复 | **BLOCKED**(无 API key) |
| active-turn refresh 不出现不可接受故障 | **BLOCKED**(无 API key) |
| 源 artifacts 未被破坏 | **PASS** |
| HTTP/WS 正常 | HTTP **PASS** / WS **PARTIAL** |
| B3 解除 | **未解除** |
| B6 解除或有明确锁定方案 | **FAIL**,有明确方案(见 §5) |

**结论:BLOCKED。保留 0.1.1 主环境。不进入 02C。**

---

## 进入 02C 前必须解决

1. **Node 版本**:确认运行环境 Node ≥ 24.2(或 22.18+),否则 0.1.5 CLI 静默失效。
2. **`.env` DSH_***:改造平台,使 dsh 子进程 cwd 下不存在含 `DSH_*` 的 `.env`(或改用 env 导出)。
3. **B6 lockfile**:为 3 个零依赖 UI 包补 importer 来源,或锁定 pnpm 版本。
4. **API key**:提供 `DEEPSEEK_API_KEY` 以完成 Session 迁移、新 V3 会话、active-turn 测试。
5. **launch token**:平台需实现 token 交换(0.1.5 已恢复该模型)。
6. **迁移实测**:在一次性 home 上通过 UI/RPC 打开 V0 会话,验证 V0→V1→V2→V3 无损与源字节保留。

## 沙箱与产物

- 沙箱:`.tools/dsh-0.1.5-rc.2/`(已加入 `.gitignore`)
- Fixtures 备份:`.tools/fixtures-02b/source-backup/`
- 全局 dsh 与主 DSH_HOME **均未改动**
