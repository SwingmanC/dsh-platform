# REWORK-08 — Operations Readiness

> 日期:2026-09-18
> 脚本:`scripts/final-e2e/{stack,concurrency,idle,secret-scan}.mjs`

---

## 1. 组件就绪

| 组件 | 状态 | 证据 |
|------|------|------|
| MySQL 8.4 | READY | `127.0.0.1:3306`;migration 007 已应用(7 列验证) |
| Redis 5.0.14 | READY | `PONG`;Gateway 日志 `session store: redis (redis://127.0.0.1:6379)` |
| Gateway | READY | `gateway listening ... (session=redis)` |
| Portal login | READY | Vite dev 5173,登录 PASS |
| DSH launcher | READY | `dsh launcher ok: node=v24.11.0 dsh=0.1.5-rc.2` |
| per-user Runtime supervisor | READY | spawn/ready/restart/idle drain PASS |
| projection roots | READY | var/final-e2e/projections 生成 + ack |
| knowledge storage | READY | var/final-e2e/kb-storage |
| MCP secret encryption | READY | AES-256-GCM envelope |
| runtime ephemeral token | READY | internal channel 认证 PASS |
| idle cleanup | READY | `idle.mjs`:drain → recover(newRuntimeId) PASS |

## 2. Health / Start / Restart / Stop / Crash recovery

| 操作 | 结果 |
|------|------|
| `GET /api/health` | 200 `{ok:true,db:...}` |
| start(Gateway) | READY |
| ensureRuntime start | READY(~8.6s 并发 2 用户) |
| Runtime restart | PASS(Phase 06/07) |
| idle stop | PASS(reaper drain) |
| crash recovery | child exit → registry 清理 → 下次 ensure 重建 PASS |

## 3. Concurrency Smoke

| 项 | 结果 |
|----|------|
| 5 用户并发 login + API read | 全部 200,114ms,0 错误 |
| 2 用户并发 ensureRuntime | 不同 runtimeId,均 ready,8.6s,0 Gateway error |
| 串用户 / 端口冲突 / spawn storm | 未出现 |

> 5 用户“真实模型请求”部分受 B5(无法开始对话)阻塞,未执行。

## 4. Backup / Restore Rehearsal

| 步骤 | 结果 |
|------|------|
| `mysqldump --single-transaction --routines --events` | 72,884 bytes,有效 SQL |
| restore 到隔离库 `dsh_platform_restore` | exit 0 |
| 校验 | 27 表 / 2 users / 17 memory rows / 2 tenants |

- 关键坑:PowerShell `>` 重定向会写 UTF-16(带 BOM),导致 restore `\0`/语法错误 → 必须用 `Start-Process -RedirectStandardOutput`(或 `--binary-mode`)。
- per-user DSH_HOME / projection / knowledge storage 为文件系统产物,备份需一并归档(测试环境为 `var/final-e2e/**`)。

**结果:PASS**

## 5. 日志可观测性

| 事件 | 可定位 |
|------|--------|
| login/auth error | Gateway logger(level 40/50)+ audit `login.failed` |
| runtime spawn/restart error | `runtime.ensure` audit + `ensureRuntime failed` |
| dsh version/node version | onReady `dsh launcher ok/FAILED` |
| launch-token bootstrap failure | proxy preHandler log |
| Skill/Knowledge/MCP/Memory sync | `/api/*/runtime-status`(desired/observed) |
| 无 Secret | 日志脱敏 launch token;不 dump body/secret |

## 6. Readiness 结论

- Redis/MySQL/launcher/idle/backup/concurrency:**READY**。
- 生产 Canary 前仍需:显式 `PLATFORM_DSH_NODE_BIN`/`PLATFORM_DSH_CLI_ENTRY`、`PLATFORM_SECRET_ENCRYPTION_KEY`、`REDIS_URL`、migration 自动化、workspace provisioning(见 B5)。