# REWORK-02B3 — 测试 Credential 注入 + 真实 V0 Fixtures

> 完成日期:2026-09-16
> 生成器:legacy `dsh 0.1.1-rc.2`(全局,未升级)
> 测试 home:`.tools/fixtures-02b/legacy-home/`
> 关联:`REWORK-02B1`(PASS)、`REWORK-02B2`(PASS)

---

## 结论:PASS

F1/F2/F3/F4/F5/F6 全部真实生成或保留。F4(steering)、F5(tool)均**支持**并已真实生成。
API Key 全链路 **0 泄漏**。

---

## 1. 每个 fixture 是否真实生成

| Fixture | 是否真实生成 | 方式 |
|---|---|---|
| F1 短多轮(4 turns) | **是** | 真实 DeepSeek API,4 轮 `session.prompt` |
| F2 长多轮(16 turns) | **是** | 真实 DeepSeek API,16 轮 |
| F3 cancel/中断 | **是** | 长请求生成中 `session.cancel` → `turn/end reason.kind=aborted (user)` |
| F4 steering | **是(旧版支持)** | 生成中 `session.prompt mode:'steer'` → `agent/inbox/spliced target:next-step` |
| F5 tool | **是(profile 有工具)** | 模型真实调用 `read` 工具 → `tool/call` + `tool/result` |
| F6 现有真实 V0 历史 | **是(保留)** | 02B 唯一有内容的 V0 会话(1 turn) |

**未编辑任何 JSONL** 构造 fixture;全部由真实 Runtime + 真实 API 生成。

## 2. Format version

**全部 6 个 fixture 均为 `version: 0`(V0)。**

## 3. 结构统计

| Fixture | events | turns | user/message | assistant/message | tool/result | bytes |
|---|---|---|---|---|---|---|
| F1 | 63 | 4 | 5 | 4 | 0 | 27826 |
| F2 | 219 | 16 | 17 | 16 | 0 | 39779 |
| F3 | 38 | 1 | 2 | 1 | 0 | 20297 |
| F4 | 49 | 2 | 3 | 2 | 0 | 29910 |
| F5 | 43 | 1 | 2 | 2 | **1** | 27361 |
| F6 | 27 | 1 | 2 | 1 | 0 | 16352 |

**关键证据:**
- F3 `turn/end`: `{"turn":1,"reason":{"kind":"aborted","reason":{"kind":"user"}}}` — 真实用户取消
- F4: turn 1 完成后,turn 2 进行中经 `agent/inbox/spliced {target:"next-step"}` 注入 steering 文本 → 真实 steering
- F5: `tool/call` + `tool/result` 各 1,真实工具执行(读取 `CMCC_F5_TEST.txt`)

## 4. SHA256

| Fixture | sessionId | SHA256 |
|---|---|---|
| F1 | `session-7eaf3b41-987c-47ce-afd7-38465bb939af` | `D95A201539EA5E274C699FD7A5FA7362D4D5D01760D54D0F409853FCDD170E17` |
| F2 | `session-609f5c9c-3dd7-4863-a7be-1c2e800851d8` | `02BEFB7DC7E17000290F3A909B8D4486A1C74ACB34DDD80A76EAF8A9C8C397ED` |
| F3 | `session-07752e08-d133-41bf-aa98-bce40f076ca6` | `3E9C438D544E3B639FE4773F36F15B15726BBF50AD43928FD3384BCFE660ECBF` |
| F4 | `session-ea581b95-e9d5-4bae-b845-3fbbaa9b9040` | `5029D16E41B6C80A80A52A2D350908CFFC8286796B0A5C23FEDC48382F892D88` |
| F5 | `session-310964ac-1a5a-46f2-b207-e67c72ba0f31` | `991DF2DAA596AA301FE7AE938033AC99632F95BD77380C572B953F08ED2912A9` |
| F6 | `session-6435826a-9f04-48b3-bc46-ae0c1a3c6d5c` | `13A6984F9972B55305DBB5C3022998386087E86847A5722BC5869DFF4BD000B4` |

完整清单:`.tools/fixtures-02b/FIXTURE-MANIFEST.csv`

## 5. API Key 泄漏扫描(全 0)

| 位置 | 结果 |
|---|---|
| Git 跟踪文件 | **0 hits** |
| `git diff`(工作区改动) | **0 hits** |
| gateway 日志 | **0 hits** |
| legacy dsh 日志 | **0 hits** |
| `t_dsh_audit_events`(前缀) | **0** |
| 报告 Markdown | **0 hits** |
| fixtures 非压缩文件 | **0 hits** |
| 20 个 `.zstd` 解压后扫描 | **0 hits** |
| `.env.example` / `README` / 源码(值) | **0 hits** |

**凭据读取方式(按要求调整):**
- 经项目现有 `.env` 加载机制(`config.ts` 的 `process.loadEnvFile`)读取 `PLATFORM_TEST_DEEPSEEK_API_KEY`
- 仅在 `supervisor.childEnv` 映射:`PLATFORM_TEST_DEEPSEEK_API_KEY → env.DEEPSEEK_API_KEY`
- `childEnv` 循环已剔除所有 `PLATFORM_*` 键 → 源变量名**不原样透传**给 DSH
- 值不落 DB / API response / 日志 / audit / Markdown / Git
- DSH 子进程 cwd 保持 user/test `DSH_HOME`(未改为项目根)

**端到端验证:** 经 Gateway 拉起 legacy runtime 并真实完成一轮(`session.prompt` → `assistant/message`),证明注入生效。

## 6. source-backup / migration-copy 状态

| 目录 | 内容 | 状态 |
|---|---|---|
| `.tools/fixtures-02b/source-backup/` | F1–F6(6 个 `.jsonl.zstd`) | **只读**(`IsReadOnly=true`),SHA256 与 manifest **全部 MATCH** |
| `.tools/fixtures-02b/migration-copy/` | F1–F6 副本 | 可写,供 02B4 迁移使用 |
| `.tools/fixtures-02b/legacy-home/` | 真实 legacy DSH_HOME(生成源) | 保留 |
| `.tools/fixtures-02b/legacy-workspace/` | F5 工具读取的测试文件 | 保留 |

源 artifacts 未被破坏;主 DSH_HOME(`var/homes`)未参与本阶段生成。

## 7. 是否满足进入 02B4 的 Gate

| Gate 条件 | 结果 |
|---|---|
| F1 短多轮 Session | **PASS**(4 turns) |
| F2 长多轮 Session | **PASS**(16 turns) |
| F3 cancel/中断 Session | **PASS**(aborted/user) |
| F4 steering | **PASS**(真实 next-step 注入) |
| F5 tool | **PASS**(真实 tool/result) |
| F6 真实 V0 历史 | **PASS**(保留) |
| format version 记录 | **PASS**(全部 V0) |
| SHA256 记录 | **PASS** |
| API Key 0 泄漏 | **PASS** |
| source-backup 只读 + 完整性 | **PASS** |

**结论:满足进入 02B4 的 Gate。**

---

## 修改文件

| 文件 | 变更 |
|---|---|
| `apps/gateway/src/supervisor.ts` | `childEnv` 增加 dev/test 映射:`PLATFORM_TEST_DEEPSEEK_API_KEY → DEEPSEEK_API_KEY`(仅当存在) |
| `.tools/fixtures-02b/` | **新增**(gitignored):legacy-home、legacy-workspace、source-backup、migration-copy、manifest、脚本 |

Gate 证据:`pnpm build` / `pnpm typecheck` / `pnpm test` 均 **EXIT 0**。

## 安全提醒

本阶段使用的测试 Key 曾以明文出现在会话中,建议测试完成后**轮换(rotate)**该 Key。仓库内(含 `.env`)均未被 Git 跟踪,`.env` 已 gitignore。
