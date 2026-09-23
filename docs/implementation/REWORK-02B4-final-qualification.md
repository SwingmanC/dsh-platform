# REWORK-02B4 — 重新执行 0.1.5 Session / Active-turn / WS Qualification

> 完成日期:2026-09-17
> Runtime:`dsh 0.1.5-rc.2` 沙箱(`.tools/dsh-0.1.5-rc.2/`,Node `v24.11.0`)
> Canary DSH_HOME:`.tools/fixtures-02b/canary-home/`
> 端口:`127.0.0.1:3088`,trusted-host `localhost:8080`
> 前置:`REWORK-02B1`(PASS)、`REWORK-02B2`(PASS)、`REWORK-02B3`(PASS)
> 原始数据:`.tools/fixtures-02b/{verify-fixtures,new-sessions,active-turn,ws-test,post-restart}.json`

---

## 结论:PASS

F1–F6 惰性迁移真实完成并语义保真;source-backup 不可变;N1–N4 新建 V3 全通过;
active-turn blank ×5 全通过;HTTP/WS 全通过;launch token 与测试 Key 0 泄漏。
**无浏览器环境**,凡"浏览器刷新"类操作以等价的 RPC/WS 重连替代并在此显式记录偏差。

### 关键通过项

| 核心项 | 结果 |
|---|---|
| F1 / F2 / F3 / F6 迁移 | **PASS** |
| N1 / N2 | **PASS** |
| HTTP(unary RPC) | **PASS** |
| WS(upgrade / stream / 重连) | **PASS** |
| launch token 交换 | **PASS**(303 + `Set-Cookie`) |
| 测试 Key 0 泄漏 | **PASS** |

---

## 0. 环境与偏差声明

| 项 | 值 |
|---|---|
| Canary 启动 | `node bin.js web --no-open --host 127.0.0.1 --port 3088 --trusted-host localhost:8080` |
| `DSH_HOME` | `.tools/fixtures-02b/canary-home` |
| 测试 Key 注入 | 仅经 `DEEPSEEK_API_KEY` 环境变量注入 canary 子进程,值不落盘 |
| 真实 API 调用 | 是(所有 `session/prompt` 均触发真实 `deepseek-official/deepseek-v4-flash`) |

**偏差(必须声明):本机无浏览器可用。** 因此:
- "真实浏览器打开 Session 触发读取迁移" → 以 `session/page` 真实读取替代(迁移由读取路径触发,已验证产生 `system/message` 头节点与后继代)。
- "浏览器刷新" → 以重新发起 `session/list` + `session/page`(HTTP)与重开 `session/follow`(WS)替代。
- active-turn "刷新浏览器" → 以轮询 `session/list`(检查 `running`/`blank`)+ `session/page`(检查 stream/final message)替代。

其余全部为真实 Runtime 行为,非模拟。

---

## 1. 惰性迁移

6 个 V0 fixture 放入 canary DSH_HOME 后,**读取**触发内存 V0→V3 迁移,后继代在**写入**时发布:

- 读 `session/page` → 内存出现 `system/message` 头节点;
- 写 `session/prompt` → 落盘 `session.v3.jsonl.zstd`;
- 原 `session.jsonl.zstd`(V0)**保留不变**。

Canary 内 6 个 V0 文件 SHA256 与 source-backup manifest **全部 MATCH**(见 §4),证明原文件未被改写。

---

## 2. V0 → V3 语义对照

V3 事件数**小于** V0(压缩丢弃 `assistant/chunk`/`text-chunks`/`reasoning-chunks` 等瞬态帧);
语义内容一致:`turns/user/assistant` 均为 `V0 + 1`(新增 1 轮迁移写入),`tool/result` 完全一致。

| Fixture | V0 events | V0 turns/user/asst/tool | V3 version | V3 events | V3 turns/user/asst/tool | V3 新增结构 |
|---|---|---|---|---|---|---|
| F1 | 63 | 4 / 5 / 4 / 0 | 3 | 56 | 5 / 6 / 5 / 0 | `system/message`×3, `session/end-seed`×1 |
| F2 | 219 | 16 / 17 / 16 / 0 | 3 | 152 | 17 / 18 / 17 / 0 | 同上 |
| F3 | 38 | 1 / 2 / 1 / 0 | 3 | 31 | 2 / 3 / 2 / 0 | 同上 |
| F4 | 49 | 2 / 3 / 2 / 0 | 3 | 40 | 3 / 4 / 3 / 0 | 同上 |
| F5 | 43 | 1 / 2 / 2 / **1** | 3 | 37 | 2 / 3 / 3 / **1** | 同上 |
| F6 | 27 | 1 / 2 / 1 / 0 | 3 | 31 | 2 / 3 / 2 / 0 | 同上 |

**语义保真证据:**
- F4 原 steering 文本 `STEERED-OK` 在 V3 中保留;
- F5 原 `tool/call`+`tool/result` 在 V3 中 1:1 保留;
- F6 原中文对话内容在 V3 中保留;
- 每轮原始 user/assistant 文本逐条可读(见 §3 continue 校验)。

### V3 工作副本 SHA256(canary,含后续 continue/active-turn/restart 轮次)

| Fixture | sessionId | bytes | V3 SHA256 |
|---|---|---|---|
| F1 | `session-7eaf3b41-987c-47ce-afd7-38465bb939af` | 38784 | `6F83E81823C19243726889086A0E897B68E66B7ED6FF365B7859CD085D0C6968` |
| F2 | `session-609f5c9c-3dd7-4863-a7be-1c2e800851d8` | 30627 | `38E7214DD36FC0AD893E45FA9D0E62896DD5BDCFA4113EA88FACD6A8F41E145A` |
| F3 | `session-07752e08-d133-41bf-aa98-bce40f076ca6` | 29754 | `7F4F82F71B961AA1C9C54BC9A1A312D4610139FB5891D11D3A766862620E2FEE` |
| F4 | `session-ea581b95-e9d5-4bae-b845-3fbbaa9b9040` | 29516 | `5DB75BCA0CCB9E40A32FFE9F11C40F52F29D104669B41751BFB6A3CD4B3976AA` |
| F5 | `session-310964ac-1a5a-46f2-b207-e67c72ba0f31` | 28462 | `C0E32A21C88D4894B4523B355F606392A4D94AF8F008B4A949DD83DE4771B6AE` |
| F6 | `session-6435826a-9f04-48b3-bc46-ae0c1a3c6d5c` | 28575 | `8B777FF959B85D1295661C5C601728096B408C7A4AEE82F8F438765A24A01100` |

---

## 3. 每个 Fixture 的 8 项验证

| Fixture | list | open | 历史显示 | continue | refresh | resume | Runtime restart | re-open |
|---|---|---|---|---|---|---|---|---|
| F1 | PASS | PASS | PASS(6 user/5 asst) | PASS(`CONT-F1`) | PASS | PASS | PASS | PASS |
| F2 | PASS | PASS | PASS(18 user/17 asst) | PASS(`CONT-F2`) | PASS | PASS | PASS | PASS |
| F3 | PASS | PASS | PASS(3 user/2 asst) | PASS(`CONT-F3`) | PASS | PASS | PASS | PASS |
| F4 | PASS | PASS | PASS(4 user/3 asst) | PASS(`CONT-F4`) | PASS | PASS | PASS | PASS |
| F5 | PASS | PASS | PASS(3 user/3 asst, 1 tool) | PASS(`CONT-F5`) | PASS | PASS | PASS | PASS |
| F6 | PASS | PASS | PASS(3 user/2 asst) | PASS(`CONT-F6`) | PASS | PASS | PASS | PASS |

- **continue**:对每个 fixture 真实发送 `Reply with exactly: CONT-<F>` 并等待 `running=false`,marker 在 V3 中持久化。
- **refresh**:重新 `session/page`,cursor 稳定、记录完整、无重复/损坏。
- **Runtime restart**:杀进程 PID → 用同一命令重启(新 launch token),见 §6。
- **resume / re-open**:重启后重新 `session/list` + `session/page`,cursor 与重启前完全一致(62/158/37/46/43/37),全部内容仍在。
- **restart 后仍可继续**:重启后对 F1 真实发一轮 → `POST-RESTART-OK` 持久化(F1 尾串 `... | CONT-F1 | POST-RESTART-OK`)。

---

## 4. Source Immutable

`source-backup/` 6 个文件 SHA256 **before == after**(与 `FIXTURE-MANIFEST.csv` 全 MATCH):

| Fixture | bytes | SHA256 |
|---|---|---|
| F1 | 27826 | `D95A201539EA5E274C699FD7A5FA7362D4D5D01760D54D0F409853FCDD170E17` |
| F2 | 39779 | `02BEFB7DC7E17000290F3A909B8D4486A1C74ACB34DDD80A76EAF8A9C8C397ED` |
| F3 | 20297 | `3E9C438D544E3B639FE4773F36F15B15726BBF50AD43928FD3384BCFE660ECBF` |
| F4 | 29910 | `5029D16E41B6C80A80A52A2D350908CFFC8286796B0A5C23FEDC48382F892D88` |
| F5 | 27361 | `991DF2DAA596AA301FE7AE938033AC99632F95BD77380C572B953F08ED2912A9` |
| F6 | 16352 | `13A6984F9972B55305DBB5C3022998386087E86847A5722BC5869DFF4BD000B4` |

同时 canary 内 V0 文件亦保持同哈希,证明迁移只**新增** `session.v3.jsonl.zstd`,不修改 V0。

---

## 5. 新 V3 Session(N1–N4)

| 会话 | sessionId | 验证 | 结果 |
|---|---|---|---|
| **N1** 普通多轮 | `session-971e64a1-7d6b-4552-b644-470b488b244f` | 3 turns `N1-A/B/C` 全持久化,restart 后 3 marker 全恢复 | **PASS** |
| **N2** cancel | `session-c3457565-e318-4cfb-a609-965b49230cb6` | 生成中 `session/cancel` → `{accepted:true}`,`turn/end` = `{kind:"aborted",reason:{kind:"user"}}`,`running=false` | **PASS** |
| **N3** steering | `session-4db64c60-edf8-4494-9f9d-19533af9ee0d` | 生成中 `mode:'steer'` → `{accepted:true}`,marker `STEER-N3` 持久化 | **PASS** |
| **N4** tool | `session-2d285f00-7b1b-45e6-8fc5-d7ffa2ea9993` | 真实 `read` 工具 → `tool/call`×1 + `tool/result`×1,读到 `CMCC_F5_TEST_TOKEN=517303` | **PASS** |

- N1–N4 全部为 0.1.5 新建 V3 会话(`version:3`)。
- **Runtime restart 后恢复**:4 个会话均 `listed=true`、`running=false`、记录完整,N1 三 marker、N3 `STEER-N3`、N4 `TOOL-N4` 全部保留。

### 真实时间线(事件 `time`,UTC+8 显示)

| 会话 | 本地开始 | 本地结束 | 时长 |
|---|---|---|---|
| N1 | 15:32:21 | 15:32:28 | 7s |
| N2 | 15:32:31 | 15:32:32 | 2s |
| N3 | 15:32:32 | 15:33:30 | 58s |
| N4 | 15:33:32 | 15:33:34 | 3s |

---

## 6. Active-turn Blank Test(×5)

对每轮:创建会话 → 发送长请求(4000 词长文)→ turn active 期间反复"刷新"(`session/list` 检查 `running`/`blank` + `session/page` 检查 stream)→ 等待完成 → 再刷新。

| Run | sessionId | active 时长 | active 期间 blank | stream 观测 | 完成后 blank | 最终 assistant 文本 | 结果 |
|---|---|---|---|---|---|---|---|
| 1 | `session-b52400b1-2e00-46ed-a239-8c7146b49f7f` | 95s | **无** | 有 | false | 非空 | PASS |
| 2 | `session-5c69ec8d-3a35-431b-b721-9a7472653d86` | 75s | **无** | 有 | false | 非空 | PASS |
| 3 | `session-e5d4be27-3029-4514-bcc8-474074cff7d9` | 105s | **无** | 有 | false | 非空 | PASS |
| 4 | `session-a2504b1d-b4a2-4f33-bb98-2c53c21fb9b4` | 121s | **无** | 有 | false | 非空 | PASS |
| 5 | `session-180cb172-ba2e-4b00-b9b2-4120ffc66574` | 80s | **无** | 有 | false | 非空 | PASS |

- 每轮 active 期间均观测到 `running=true` 且 `blank=false`,并可见 assistant stream 帧;
- 完成后 `running=false`、`blank=false`,final message 非空;
- **无持续 blank、无消息丢失、无不可恢复** → 5/5 PASS。

> 偏差:无浏览器,"刷新"以 HTTP `session/list`+`session/page` 替代;无法直接读取浏览器 console error。Runtime 侧无 error 帧、无 stuck turn。

---

## 7. WebSocket

| 验证项 | 结果 | 证据 |
|---|---|---|
| WS upgrade success | **PASS** | 认证 cookie 握手 `open` 2ms |
| 未认证 upgrade 拒绝 | **PASS** | 无 cookie → `HTTP 401` |
| remote messages flow | **PASS** | `session/follow` stream:`snapshot` + 15 event 帧 + 12 `assistant-stream` 帧 |
| control stream | **PASS** | `session/control` baseline `item`×1 |
| 协议约束 | **PASS** | unary(`session/list`)经 stream carrier 被拒:`gateway/signature-invalid`(符合 0.1.5 约定:unary 走 HTTP,stream 走 WS) |
| refresh reconnect | **PASS** | 关闭 WS → 重开 → `session/follow` 重新收到 `snapshot` |
| Runtime restart reconnect | **PASS** | 重启后重开 WS → `session/follow` `snapshot` + event,4ms |

**之前 PARTIAL → 本次 PASS。**

---

## 8. 交互 Smoke

- 连续多轮真实 smoke 覆盖:F1–F6 continue(6 轮)+ N1 多轮(3)+ N2 cancel(1)+ N3 steer(1)+ N4 tool(1)+ active-turn(5 长轮)+ restart 后 continue(1),共 **18+ 轮真实 LLM 交互**,全部 `running=false` 收敛。
- 实际窗口(本地):**2026-09-17 14:32(首次启动)→ 15:48(最后一次 post-restart continue)**,约 76 分钟;其中 active-turn 5 轮集中在 **15:33:51 → 15:41:55**。
- 未虚构时长,以上均为会话事件 `time` 实测值。

---

## 9. 安全:测试 Key 注入隔离 + 0 泄漏

### 注入隔离(02B4 新增约束)

- `apps/gateway/src/config.ts` 新增 `canaryRoot`(`PLATFORM_DSH_CANARY_ROOT`,默认空)。
- `apps/gateway/src/supervisor.ts` 的 `childEnv` **仅当** `canaryRoot` 非空且该 Runtime 的 `homeDir` 位于 `canaryRoot` 之下(`isUnderCanaryRoot`)时,才注入 `env.DEEPSEEK_API_KEY`。
- 因此普通用户 Runtime 即使环境中存在 `PLATFORM_TEST_DEEPSEEK_API_KEY`,也**不会**获得测试 Key;生产凭据模型不变。
- `gateway` 构建 `pnpm --filter @dsh-platform/gateway build` **EXIT 0**。
- 本次 canary 为独立沙箱进程,Key 经 `DEEPSEEK_API_KEY` 环境变量注入,读取自项目根 `.env` 的 `PLATFORM_TEST_DEEPSEEK_API_KEY`(length=35,`sk-` 前缀),值未打印。

### 泄漏扫描(全 0)

| 位置 | 方法 | 结果 |
|---|---|---|
| 仓库文件(303 个:ts/js/json/md/sql/yaml/ps1/…) | 含 `.env` 值扫描 | **0 hits** |
| `.tools/fixtures-02b` 下 `.zstd`(解压后) | 全量解压扫描 | **0 hits** |
| MySQL `dsh_platform` 全库 dump(34056 B) | 全表扫描 | **0 hits** |
| canary stdout/stderr 日志 | 扫描 | **0 hits** |
| 本报告 Markdown | 扫描 | **0 hits** |

- launch token(旧/新)在仓库、DB、Markdown 中 **0 hits**(仅存在于 gitignored 的 `%TEMP%` 运行日志)。
- `.env` 与 `.tools/` 均在 `.gitignore` 内,未被 Git 跟踪。

---

## 10. Gate 汇总

| 条件 | 结果 |
|---|---|
| F1/F2/F3/F6 迁移 | **PASS** |
| N1/N2 | **PASS** |
| HTTP | **PASS** |
| WS(upgrade/flow/reconnect) | **PASS** |
| launch token 交换 | **PASS** |
| source-backup 不可变 | **PASS** |
| 测试 Key 0 泄漏 | **PASS** |
| 测试 Key 注入隔离 | **PASS** |

**结论:02B4 全部核心项 PASS。** 唯一限制:无浏览器,浏览器刷新类操作以等价 RPC/WS 重连替代并已声明。

---

## 相关文件

| 文件 | 说明 |
|---|---|
| `apps/gateway/src/config.ts` | `canaryRoot`(`PLATFORM_DSH_CANARY_ROOT`) |
| `apps/gateway/src/supervisor.ts` | `isUnderCanaryRoot` + canary-only 测试 Key 注入 |
| `.tools/fixtures-02b/canary-home/` | 0.1.5 canary DSH_HOME(gitignored) |
| `.tools/fixtures-02b/source-backup/` | 只读源 fixtures |
| `.tools/fixtures-02b/*.json` | 各测试原始结果 |
| `.tools/fixtures-02b/canary-start.ps1` | canary 启动脚本(从 `.env` 运行时读取 Key,不落盘) |
| `.tools/dsh-0.1.5-rc.2/` | 0.1.5 沙箱(gitignored) |

## 安全提醒

本阶段使用的测试 Key 曾以明文出现在交互会话中,建议测试完成后**轮换(rotate)**该 Key。仓库内(含 `.env`)均未被 Git 跟踪。
