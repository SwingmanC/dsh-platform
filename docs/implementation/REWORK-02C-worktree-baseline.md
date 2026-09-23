# REWORK-02C — Worktree Baseline

> 生成时间:2026-09-17
> 目的:在 02C 修改代码前,冻结工作区基线,区分 02B 既有改动与 02C 新增。
> 前置:`REWORK-02B5-upgrade-gate.md` = `GO_TO_02C`。

---

## 1. Branch

```text
main (up to date with origin/main)
HEAD = a8a72ad chore: scaffold dsh-platform workspace
```

仓库仅 2 个 commit(`d6ae9ec` Initial、`a8a72ad` scaffold),02A/02B 的改动**均未提交**。

## 2. git status(修改,已跟踪文件)

```text
 M .env.example
 M .gitignore
 M README.md
 M apps/gateway/package.json
 M apps/gateway/src/db.ts
 M apps/gateway/src/index.ts
 M apps/gateway/src/supervisor.ts
 M apps/portal/package.json
 M apps/portal/src/main.tsx
 M apps/portal/vite.config.ts
 M db/schema.sql
 M package.json
 M packages/dsh-bridge/package.json
 M packages/dsh-bridge/src/client.ts
 M packages/dsh-bridge/src/host.ts
 M packages/dsh-bridge/tsconfig.json
 M packages/shared/src/dto.ts
 M packages/shared/src/types.ts
 M pnpm-lock.yaml
 M pnpm-workspace.yaml
```

## 3. 02B1–02B4 已修改的平台源码(阶段归属)

| 文件 | 归属 |
|---|---|
| `apps/gateway/src/config.ts` | 02B1 / 02B4 |
| `apps/gateway/src/supervisor.ts` | 02B1 / 02B2 / 02B3 / 02B4 |
| `apps/gateway/src/index.ts` | 02B1 |
| `apps/gateway/src/proxy.ts` | 02B2 |
| `package.json` | 02B1 |
| `.env.example` / `.gitignore` / `README.md` / `pnpm-lock.yaml` | 02B1 |

## 4. 已有 untracked 源码(非 02C 新增,勿误判)

```text
apps/gateway/src/audit.ts
apps/gateway/src/auth/
apps/gateway/src/config.ts
apps/gateway/src/fastify.d.ts
apps/gateway/src/platform.ts
apps/gateway/src/profile-patch.ts
apps/gateway/src/proxy.ts
apps/gateway/src/repositories/
apps/gateway/src/routes/
apps/gateway/src/services/
apps/gateway/src/session-sync.ts
apps/gateway/src/tools/
apps/gateway/tests/
apps/portal/src/api.ts
apps/portal/src/components/
apps/portal/src/hooks.ts
apps/portal/src/locales/
apps/portal/src/pages/
apps/portal/src/router.ts
apps/portal/src/styles/
apps/portal/src/vite-env.d.ts
packages/connector/
packages/knowledge-base/
packages/skill-plaza/
docs/implementation/
docs/operations/
cmcc-dsh-agent-prompts/
cmcc-dsh-integration-fix-prompts/
THIRD_PARTY_NOTICES
start.ps1 / stop.ps1
packages/dsh-bridge/client.bundle.js
```

## 5. Gitignore / 跟踪边界

| 路径 | 跟踪 | 说明 |
|---|---|---|
| `.env` | 未跟踪 | `.gitignore:4`;本阶段不读取/输出其内容 |
| `.tools/` | 未跟踪 | `.gitignore:9`;0.1.5 沙箱与 qualification 产物 |
| `var/` | 未跟踪 | `.gitignore:8` |
| `dist/` / `lib/` | 未跟踪 | 构建产物 |
| `dump.rdb` | 未跟踪 | **02C 新增 `.gitignore:10`**(本地 Redis 测试产物,不提交) |

## 6. 02C 计划新增/修改(预期)

- 修改:`packages/dsh-bridge/*`(去除双真源)、`apps/gateway/src/profile-patch.ts`(canary composition)。
- 新增:`packages/cmcc-platform-ui/*`。
- 新增文档:`docs/implementation/REWORK-02C-*.md`。

---

## 附:环境事实

- Node(平台):`F:\nvm\nvm\v24.11.0\node.exe`
- 系统 PATH 默认 node:`v24.0.0`(对 0.1.5 不安全,必须显式 launcher)
- pnpm:`11.7.0`(packageManager 固定)
- 0.1.5 沙箱:`.tools/dsh-0.1.5-rc.2/`(Node `v24.11.0`)
- 主环境:`dsh 0.1.1-rc.2`(全局,**未升级**)
