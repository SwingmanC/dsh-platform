# REWORK-02B1 — Runtime / Env / Lockfile 阻塞解除

> 完成日期:2026-09-16
> 范围:仅解除 02B 的三个阻塞(Node、`.env` DSH_* ownership、frozen lockfile)
> 未涉及:launch-token、Session 迁移、插件开发(留待 02B2+)

---

## 结论:PASS

三个阻塞全部解除,Gate 全绿。可进入 02B2。

---

## A. Node Runtime 固定

### A1. 显式 launcher(不再依赖 PATH)

新增平台配置(`apps/gateway/src/config.ts`):

| 配置 | 环境变量 | 默认 |
|---|---|---|
| `config.dsh.nodeBin` | `PLATFORM_DSH_NODE_BIN` | `''`(空) |
| `config.dsh.cliEntry` | `PLATFORM_DSH_CLI_ENTRY` | `''`(空) |

Supervisor 启动逻辑(`apps/gateway/src/supervisor.ts`):

```ts
function spawnDsh(args, options) {
  const { nodeBin, cliEntry, bin } = config.dsh
  if (nodeBin !== '' && cliEntry !== '') {
    return spawn(nodeBin, [cliEntry, ...args], options)   // 显式 node + CLI
  }
  // 回退:PATH 上的 dsh(0.1.1 兼容,Windows 经 shell)
  ...
}
```

- 路径全部来自配置,**不硬编码**。
- 未配置时保持原 PATH 行为,主环境(0.1.1)不受影响。

### A2. Preflight

新增 `probeDshLauncher()`,在网关 `onReady` 执行:

```text
<nodeBin> --version
<nodeBin> <cliEntry> --version
```

- 要求 Node 命中 `v24.11.*` / `v24.12.*` / `v22.19.*` / `v22.20.*`(排除会静默退出的 24.0.0/24.1.x/23.x)。
- 要求 DSH 为 `0.1.5*`。
- 未配置 launcher 时视为 N/A(回退模式)。

**实测证据:**

| 场景 | 日志 |
|---|---|
| 配置 launcher(node 24.11.0 + dsh 0.1.5-rc.2) | `dsh launcher ok: node=v24.11.0 dsh=0.1.5-rc.2` |
| 未配置 launcher | `dsh launcher: PATH fallback (dsh)` |
| 两种场景下网关 | 均正常 `listening`,`/api/health` → `{"ok":true,"db":true}` |

### A3. 平台 engines

- 根 `package.json` `engines.node` 从 `>=22` 收紧为 **`>=22.19.0`**(排除已知 `import.meta.main` 缺失的 22.0–22.18)。
- Node 24.0.0/24.1.x 无法用简单 semver 范围表达排除,改由 **A2 运行时 preflight** 拦截(符合提示词"对 DSH Runtime 单独做严格 preflight")。

---

## B. `.env` 中 DSH_* Ownership

### B1. 重命名

平台自身配置全部从 `DSH_*` 改为 `PLATFORM_DSH_*`:

| 旧 | 新 |
|---|---|
| `DSH_HOMES_ROOT` | `PLATFORM_DSH_HOMES_ROOT` |
| `DSH_WORKSPACES_ROOT` | `PLATFORM_DSH_WORKSPACES_ROOT` |
| `DSH_BIN` | `PLATFORM_DSH_BIN` |
| `DSH_UI_AUTHORITY` | `PLATFORM_DSH_UI_AUTHORITY` |
| `DSH_BIND_HOST` | `PLATFORM_DSH_BIND_HOST` |
| `DSH_VERSION` | `PLATFORM_DSH_VERSION` |
| `DSH_IDLE_TTL_MS` | `PLATFORM_DSH_IDLE_TTL_MS` |
| `DSH_HEARTBEAT_MS` | `PLATFORM_DSH_HEARTBEAT_MS` |
| `DSH_MOCK_UPSTREAM` | `PLATFORM_DSH_MOCK_UPSTREAM` |
| —(新增) | `PLATFORM_DSH_NODE_BIN` |
| —(新增) | `PLATFORM_DSH_CLI_ENTRY` |

同步更新:`.env.example`、`.env`(本地,保留原值)、`README.md`。

**验证:** `apps/gateway/src/config.ts` 中已无平台 `DSH_*` 读取;测试无 `DSH_*` 引用。

### B2. 子进程 DSH_HOME 仍由 spawn 注入

`supervisor.ts` 保留:

```ts
env.DSH_HOME = homeDir   // 注入子进程,不写入 repo .env
```

`childEnv` 仍剔除 `DSH_*` 与 `PLATFORM_*`,子进程 cwd 为用户 homeDir → 不会读到平台根 `.env`。

### B3. 实测:0.1.5 拒绝 `.env` 中的 DSH_*

沙箱验证(02B 已记录):当 dsh 以 cwd=仓库根启动时,`loadLayeredEnv` 抛错:
```
dsh: <repo>/.env sets "DSH_HOMES_ROOT", which only the launching environment may set
```
本次重命名后,repo `.env` 不再含 `DSH_*`;且 Supervisor 用 `cwd=homeDir`,双重规避。

---

## C. Frozen Lockfile

### C1. 根因

`packages/{connector,knowledge-base,skill-plaza}` 是**零依赖** workspace 包。
- **pnpm 12.4.1**:不为零依赖包写入 importer,但 `--frozen-lockfile` 要求存在 → `ERR_PNPM_PACKAGE_MANAGER_NO_IMPORTER`。
- `pnpm install --lockfile-only` / `pnpm install`(12.4.1)均不补。

### C2. pnpm 11.7.0 隔离验证

`npx -y pnpm@11.7.0 install --frozen-lockfile`:
```
Scope: all 9 workspace projects
Lockfile is up to date, resolution step is skipped
Lockfile passes supply-chain policies (260 entries)
Done in 4.1s using pnpm v11.7.0
EXIT: 0
```
→ 11.7.0 **自动补全**了缺失的 importer(`packages/connector: {}` 等),随后 frozen 通过。

### C3. 锁定 packageManager

根 `package.json` 新增:
```json
"packageManager": "pnpm@11.7.0"
```
- 实测:此后 `pnpm --version` → **11.7.0**(pnpm 自管理,自动切换)。
- **未静默替换用户全局 pnpm**(全局仍为 12.4.1,仅在项目内生效)。
- lockfile 现含全部 9 个 importer。

---

## Gate 证据

| 步骤 | 命令 | 结果 |
|---|---|---|
| pinned pnpm | `pnpm --version` | `11.7.0` |
| frozen install | `pnpm install --frozen-lockfile` | **EXIT 0** |
| build | `pnpm build` | **EXIT 0** |
| typecheck | `pnpm typecheck` | **EXIT 0** |
| test | `pnpm test` | **EXIT 0**(39/39) |

全部 PASS。

---

## 修改文件

| 文件 | 变更 |
|---|---|
| `apps/gateway/src/config.ts` | `DSH_*`→`PLATFORM_DSH_*`;+`nodeBin`/`cliEntry` |
| `apps/gateway/src/supervisor.ts` | `spawnDsh` 支持显式 node+CLI;+`probeDshLauncher` |
| `apps/gateway/src/index.ts` | `onReady` 执行 launcher preflight 并记录 |
| `package.json` | +`packageManager: pnpm@11.7.0`;+`test` 脚本;`engines.node >=22.19.0` |
| `.env.example` | 重命名 + 新增 launcher 项 |
| `.env`(本地) | 重命名(保留原值) |
| `README.md` | 更新环境变量引用 |
| `pnpm-lock.yaml` | pnpm 11.7.0 补全 3 个零依赖包 importer |
| `.gitignore` | +`.tools/`(02B 沙箱) |

---

## 遗留(不属本阶段)

1. **launch-token 交换** → 02B2
2. **Session 迁移实测 / API key** → 02B3
3. **active-turn 浏览器测试 / WS 完整验证** → 02B4
4. `.tools/dsh-0.1.5-rc.2` 沙箱仍在(gitignored),供 02B2+ 复用。

**B1/B3(env ownership)/B6(lockfile)已解除。可进入 02B2。**
