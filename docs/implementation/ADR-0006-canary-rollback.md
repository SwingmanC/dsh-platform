# ADR-0006 — Canary Rollback Strategy

> 状态:已评估(组织决策待定)
> 日期:2026-09-18
> 关联:Phase 08 FINAL E2E / Canary Readiness Gate

---

## 背景

Canary 前必须回答:0.1.5 写过 V3 Session 后,能否无损切回 0.1.1?

## 实测(隔离测试 DSH_HOME,未触碰真实用户 home)

| 步骤 | 命令 | 观测 |
|------|------|------|
| 0.1.5 headless 真实模型调用 | `node v24.11 dsh-0.1.5/bin.js --profile headless "Reply OK"` | 输出 `OK`;生成 `sessions/<cwd>/session-<id>/session.v3.jsonl.zstd` |
| 0.1.1 同一 home 新会话 | `node v24.11 global-dsh-0.1.1/bin.js --profile headless "Reply OK"` | 生成 `session.jsonl.zstd`(无 `.v3`);V3 文件被忽略 |
| 0.1.1 resume V3 | `dsh-0.1.1 --profile headless --resume <v3-session-id>` | `error: unknown option '--resume'` |

### 关键事实

- 0.1.5 的 session 持久化文件名为 `session.v3.jsonl.zstd`;0.1.1 为 `session.jsonl.zstd`。
- 0.1.1 **不存在** `dsh-session-format` 抽象与 `v0→v1→v2→v3` 迁移包;0.1.5 存在(仅**前向**迁移)。
- 0.1.1 不识别 `.v3.jsonl.zstd`,也**不支持 `--resume`**。

## 结论

```text
NO_IN_PLACE_DOWNGRADE_AFTER_V3_WRITES
```

一旦 0.1.5 写入 V3 Session,原地切回 0.1.1 后这些会话**不可读**(0.1.1 静默忽略或无法 resume),且无反向迁移路径。

---

## 必须区分的两类回滚

### Process rollback(可执行)

- 回退 Gateway 代码 / profile 组合到升级前版本。
- 保留 0.1.1 fallback(不得删除)。
- 风险低,可随时执行。

### Data rollback(受限)

- **DB**:`mysqldump` 快照 → restore 已演练 PASS(27 表 / users / memory 可读)。
- **per-user DSH_HOME**:升级前快照(目录归档)→ restore 到隔离/原目录。
- **V3 之后**:无法通过 0.1.1 读取,必须 restore 快照(丢失 V3 之后的新会话),或 forward-fix。

## Canary 方案选项(需组织决策,Agent 不代选)

```text
A. 仅专用 internal/test users + 允许 restore snapshot(可执行)
B. 有经验证 data-forward/restore strategy(需实现)
C. 不允许 downgrade,只允许 forward-fix,风险明确接受
```

- A 在测试环境**已可执行**(DB restore 已演练;DSH_HOME 目录快照)。
- C 需组织明确接受数据丢失/不可回退风险。
- 真实用户 Canary 若选 A,必须限定 allowlist 测试账号并保留升级前快照。

## 现状判定

- Process rollback:可执行。
- Data rollback:对 **canary 专用账号 + 快照** 可执行;对**全量真实用户**当前**不可执行**。
- 因此:若 Canary 目标包含真实普通用户且无快照策略 →

```text
ROLLBACK_STRATEGY = NOT_EXECUTABLE_FOR_REAL_USERS
```

**该硬项未满足 → 见 `REWORK-08-final-readiness.md` Final Decision。**