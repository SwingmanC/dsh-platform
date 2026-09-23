# REWORK-02C — 插件构建与官方契约修复(结果报告)

> 完成日期:2026-09-17
> 前置:`REWORK-02B5-upgrade-gate.md` = `GO_TO_02C`
> Runtime:`dsh 0.1.5-rc.2` 沙箱,Node `v24.11.0`,launch-token Gateway bootstrap,canary DSH_HOME
> 契约来源:tag `dsh-v0.1.5-rc.2` 官方源码(见 `REWORK-02C-client-contract.md`)

---

## 结论:`GO_TO_PHASE_03`

四类问题全部解决:

| 问题 | 状态 |
|---|---|
| `PLUGIN_DOUBLE_SOURCE` | **FIXED**(dsh-bridge 单一真源;手写 bundle 删除) |
| `CLIENT_CONTRACT` | **FIXED**(按 tag exact contract 实现 + bundle 契约测试) |
| `HOST_API_CONTRACT` | **FIXED**(删除猜测 `ctx.tools?.guard`) |
| `SDK_DRIVER_PRODUCTION_PATH` | **DEFERRED_WITHOUT_PRODUCTION_PATH**(无生产调用点) |

链路已闭环:**真实 TS source → 真实 build → 官方 client bundle → 0.1.5 Runtime Boot Graph → sidebar.panellist / main keyed → selectPanel / conversation**。

**未执行(生产 Canary 前 blocker,非 02C blocker):**

```text
REAL_BROWSER_REFRESH_E2E = REQUIRED_BEFORE_CANARY_CUTOVER
```

---

## 1. PLUGIN_DOUBLE_SOURCE — FIXED

### 修复前(双真源)
- `packages/dsh-bridge/src/client.ts` 是死占位(不注册任何组件);
- `packages/dsh-bridge/client.bundle.js` 是**人工维护的另一份真代码**(实际被 Runtime 加载);
- `package.json` `exports["./client"] → ./client.bundle.js`,与源码无关。

### 修复后(单一真源)
| 文件 | 角色 |
|---|---|
| `packages/dsh-bridge/src/client/index.tsx` | **唯一** client 真源(React 组件 + `apply`) |
| `packages/dsh-bridge/src/index.ts` | Host 半区(identity 读取) |
| `packages/dsh-bridge/lib/client.js` | **构建产物**(gitignored) |
| `packages/dsh-bridge/lib/index.js` | **构建产物**(gitignored) |
| `packages/dsh-bridge/client.bundle.js` | **已删除** |
| `packages/dsh-bridge/src/client.ts` / `src/host.ts` | **已删除** |

- 构建:`tsc -p tsconfig.build.json`(Host)+ `node scripts/build-client.mjs`(Client)。
- 手写 bundle 不再存在;`profile-patch.ts` 不再引用 `client.bundle.js`。
- 契约测试:`packages/dsh-bridge/tests/client-contract.test.mjs`(1 pass)。

## 2. CLIENT_CONTRACT — FIXED

完整 exact contract 记录于 `docs/implementation/REWORK-02C-client-contract.md`(官方 source file path + 类型 + 签名 + 采用方式)。关键项:

- client entry `src/client/index.tsx`;产物 `lib/client.js`;包装 `window.__ModuleLoader__.load({ id, factory })`。
- module table baseline 仅 `react` / `react/jsx-runtime`(本插件只 require 这两个)。
- `ctx.slots.inject(slot, cb)` + `ctx.slots.register(options, component)`。
- `sidebar.panellist`(list/root,owner `{size, active}`)。
- `main`(keyed/root,保留 key `conversation`)。
- `MainPanelId` / `ctx.layout.selectPanel(id | null)` / `usePanelInfo(selector)`。

构建链复刻官方 `packages/client/tsdown.client.ts` 的 `clientConfig`:
`format cjs`、`platform browser`、`entryFileNames client.js`、banner/intro/footer 一致。
工具:`scripts/build-client.mjs`(esbuild 0.25.12,已加入 root devDependencies)。

## 3. HOST_API_CONTRACT — FIXED

- 官方确证存在 guard 扩展点:`@deepseek-ai/dsh-tools` `ToolRuntime.guard(guard: ToolGuard)`,`ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined`。
- 历史实现 `ctx.tools?.guard((call: {name, cwd}) => ...)` 的 `cwd` 字段**无官方依据**(`ToolExecutionInput` 无 `cwd`),属猜测 API,且可能在 `cwd` 缺失时**拒绝所有工具调用**。
- 当前平台无该 guard 的生产消费者;工作区越界已由 Gateway `isWithinUserRoot` 与 dsh sandbox 围栏。
- **决策:删除猜测调用**(符合 02C §10)。Host 半区保留最小职责:读取 Supervisor 注入的可信 identity env(`readIdentity` / `isWithinRoot`),不 provide 无消费者的 service。
- 静态扫描:`tools?.guard` 仅剩说明性注释,无 active 调用。

## 4. SDK_DRIVER_PRODUCTION_PATH — DEFERRED_WITHOUT_PRODUCTION_PATH

- grep 全仓库:`packages/sdk-driver` 无任何生产 import / 调用点;唯一提及是 `routes/platform.ts:100` 的 `/api/sessions/migrate` **501 提示字符串**(该 route 不调用本包)。
- 生产 Runtime 实际由 `apps/gateway/src/supervisor.ts` 直接 spawn `dsh`,不依赖 sdk-driver。
- 处理:description 标记 `实验性 / 未激活(DEFERRED_WITHOUT_PRODUCTION_PATH)`;移除误导性的 0.1.1 时代 peer(`@deepseek-ai/dsh-sdk-client@0.1.2-rc.1`);源码头注明状态与启用前提(必须按 0.1.5-rc.2 exact contract 实现 + contract tests)。
- 结果:**生产 route 不会调到 TODO**。

## 5. cmcc-platform-ui build pipeline

新增 `packages/cmcc-platform-ui/`:

```text
src/index.ts            Host 半区(无逻辑,插件图入口)
src/client/index.tsx    Client 真源(cmcc.smoke)
lib/index.js            tsc 产物
lib/client.js           esbuild 产物(官方 __ModuleLoader__ 包装)
```

`lib/client.js` 实测(本地):4277 bytes;首行
`window.__ModuleLoader__.load({ id: "@dsh-platform/cmcc-platform-ui", factory: (require) => {`;
仅 `require("react/jsx-runtime")`(baseline);`module.exports` 导出 `apply` / `inject` / `name`。

## 6. cmcc.smoke Slot registration

实现(`src/client/index.tsx`,exact contract):

```ts
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
  { name: 'sidebar.panellist', id: 'cmcc.smoke', order: 100, label: '中国移动能力中心' }, CmccPanelIcon))
ctx.slots.inject('main', () => ctx.slots.register(
  { name: 'main', key: 'cmcc.smoke',
    inject: () => ({ selectPanel: (id) => ctx.layout.selectPanel(id) }) }, CmccSmokePanel))
```

- `CmccSmokePanel` 经 `usePanelInfo((info) => info.activePanelId)` 读当前 panel;按钮 `selectPanel(null)` 回 conversation。
- 中央内容仅诊断:`CMCC Platform UI` / `Plugin contract smoke: OK` / `DSH target: 0.1.5-rc.2` / `Build revision: 02C-1` / `Active panel`。无虚构业务数据。
- React 组件不接收 ctx;`selectPanel` 经 register `inject` 工厂注入。
- 无 React Router / `window.location` / iframe / querySelector / MutationObserver。

**契约测试**(`packages/cmcc-platform-ui/tests/client-contract.test.mjs`,3 pass):
评估 `lib/client.js` → 捕获 `__ModuleLoader__.load` → mock module table materialize → fake ctx 调 `apply` → 断言两个 slot 的 exact options 与 `selectPanel` 委派。**PASS**。

## 7. Canary composition

`apps/gateway/src/profile-patch.ts` 现组合:

```yaml
- insert:
    - id: "@dsh-platform/dsh-bridge"
      name: "@dsh-platform/dsh-bridge"
    - id: "@dsh-platform/cmcc-platform-ui"
      name: "@dsh-platform/cmcc-platform-ui"
```

- 旧 `skill-plaza` / `knowledge-base` / `connector` **不再进入 canary composition**(源码冻结保留,未删除)。
- 未影响主 0.1.1 用户 / 主 `var/homes`(主环境未启动,未 spawn 主 runtime)。
- 实测运行中 canary runtime 的 `platform-patch.yml` 仅含上述两项。

## 8. `__DSH_BOOT__` evidence

经运行中 Gateway(launcher preflight `node=v24.11.0 dsh=0.1.5-rc.2`)取得真实 boot graph:

```text
dsh-bridge        rev=5925162d84c3227f-44  inject=["@deepseek-ai/dsh-client-ui-renderer"]
cmcc-platform-ui  rev=5925162d84c3227f-45  inject=["@deepseek-ai/dsh-client-ui-renderer","@deepseek-ai/dsh-client-ui-layout"]
application batch rev=c873636e7346 含 @dsh-platform/dsh-bridge/client.js 与 @dsh-platform/cmcc-platform-ui/client.js
```

- boot graph **不含** skill-plaza / knowledge-base / connector。
- 拉取服务端 artifact(带 `rev`):
  - `cmcc-platform-ui`:HTTP 200,4345 bytes,`__ModuleLoader__.load`=true,`Plugin contract smoke: OK`=true,`cmcc.smoke`=true,`02C-1`=true。
  - `dsh-bridge`:HTTP 200,4067 bytes,`sidebar.footer.action`=true,`platform-account`=true。
- 证明加载的是**刚从 source 构建的新 artifact**(rev 与内容 marker 一致),而非旧手写 bundle。

## 9. Runtime regression

| 检查 | 结果 |
|---|---|
| launcher preflight | **PASS** `dsh launcher ok: node=v24.11.0 dsh=0.1.5-rc.2` |
| Runtime start | **PASS**(canary runtime 由 gateway spawn,`--patch` 指向新 patch) |
| launch-token bootstrap | **PASS** 303 + `Location: /`(无 token) |
| clean root 200 | **PASS**(28298 bytes) |
| HTTP API | **PASS** `/api/health` → `{"ok":true,"db":true}` |
| WS upgrade | **PASS**(open 3ms) |
| WS reconnect | **PASS**(open 7ms) |
| Session list/open | **PASS** `session/list` 200 ok count=3;`session/page` 200 ok records=18 |
| Runtime restart | **PASS**(kill dsh → 重新 spawn → 303 → 200 → boot graph 仍含两插件) |
| Gateway 错误日志 | 仅 Redis 连接拒绝(session store 降级 memory,预期);**无插件加载错误** |

## 10. Static scan

| 模式 | 分类 | 说明 |
|---|---|---|
| `ctx.tools?.guard` | **已清除** | 仅 dsh-bridge 说明性注释 |
| `client.bundle.js` | LEGACY_FROZEN / DOC | skill-plaza/knowledge-base/connector 的旧 bundle 冻结保留;profile-patch 注释说明已删除引用 |
| `window.location.href` | ACTIVE_PRODUCTION_PATH(portal) | Portal SPA 既有;02C 新路径未使用(dsh-bridge 用 `location.assign` 做退出登录整页导航) |
| `iframe` / `MutationObserver` / `querySelector` | 仅注释 | cmcc/dsh-bridge 注释声明规避,无 active 使用 |
| `TODO` / `throw new Error` | ACTIVE / LEGACY_FROZEN / DEFERRED | gateway/portal 为正常校验;legacy 包冻结;sdk-driver 已标 DEFERRED |

**02C 新主路径不依赖**:手写 bundle、猜测 API、DOM hack、第二套 SPA 导航。

## 11. Modified files(02C 专属)

### 新增
| 文件 | 说明 |
|---|---|
| `packages/cmcc-platform-ui/package.json` | 新包 |
| `packages/cmcc-platform-ui/tsconfig.json` / `tsconfig.build.json` | 构建/类型 |
| `packages/cmcc-platform-ui/src/index.ts` | Host 半区 |
| `packages/cmcc-platform-ui/src/client/index.tsx` | Client 真源(cmcc.smoke) |
| `packages/cmcc-platform-ui/tests/client-contract.test.mjs` | 契约测试 |
| `packages/dsh-bridge/src/client/index.tsx` | Client 真源 |
| `packages/dsh-bridge/src/index.ts` | Host 半区(替换 host.ts) |
| `packages/dsh-bridge/tests/client-contract.test.mjs` | 契约测试 |
| `packages/dsh-bridge/tsconfig.build.json` | Host 构建 |
| `scripts/build-client.mjs` | 共享 client bundle 构建器 |
| `docs/implementation/REWORK-02C-worktree-baseline.md` | 基线 |
| `docs/implementation/REWORK-02C-client-contract.md` | 契约 |
| `docs/implementation/REWORK-02C-plugin-contract-result.md` | 本报告 |

### 修改
| 文件 | 变更 |
|---|---|
| `packages/dsh-bridge/package.json` | 单一真源 main/exports/dsh.client;build/test 脚本;移除 0.1.1 依赖 |
| `packages/dsh-bridge/tsconfig.json` | 支持 TSX/DOM |
| `packages/dsh-bridge/src/host.ts` | **删除** |
| `packages/dsh-bridge/src/client.ts` | **删除**(死占位) |
| `packages/dsh-bridge/client.bundle.js` | **删除**(手写 bundle) |
| `apps/gateway/src/profile-patch.ts` | canary composition(dsh-bridge + cmcc-platform-ui;移除 legacy UI) |
| `packages/sdk-driver/package.json` | 标记 DEFERRED;移除误导 peer |
| `packages/sdk-driver/src/index.ts` | 状态说明头 |
| `package.json`(root) | +`esbuild@0.25.12` devDependency |
| `.gitignore` | +`dump.rdb` |
| `pnpm-lock.yaml` | esbuild 固定 + 移除 dsh-bridge 0.1.1 依赖 |

> 说明:仓库其余 `M` 文件(`db.ts`、`apps/portal/*`、`packages/shared/*` 等)属 02A/02B 既有改动,非 02C 引入。

## 12. Carry-over risks

1. **`REAL_BROWSER_REFRESH_E2E = REQUIRED_BEFORE_CANARY_CUTOVER`**(无浏览器;slot 验证为 bundle 契约测试 + boot graph,非真实渲染)。
2. **Slot 注册未在真实 `ui-renderer` SlotCore 内运行**:`@deepseek-ai/dsh-client-ui-slots` 未随 Runtime 安装(仅 shell 内建),无法在 Node 侧实例化真实 registry;已用 exact options 契约测试替代。
3. **dsh-bridge 退出登录使用 `window.location.assign('/login')`**:整页导航(非 SPA 路由);目标 `/login` 在 dsh authority 下是否可解析未在真实浏览器验证(既有行为,未改变)。
4. **测试 Key**:`.env` 中 `PLATFORM_TEST_DEEPSEEK_API_KEY` 仍存在(本阶段未使用 LLM);**operator 需手工 rotate**。
5. **legacy client.bundle.js 仍冻结在仓库**(skill-plaza/knowledge-base/connector):不在 canary composition,但源码未删。
6. Redis 未运行,gateway session store 降级 memory(单实例开发可用;生产需 Redis)。

## 13. Final decision

```text
GO_TO_PHASE_03
```

满足 §18 全部条件:

- [x] dsh-bridge 不再双真源
- [x] cmcc-platform-ui source → build → runtime
- [x] 旧手写 modal bundle 不再是 canary 主 UI
- [x] sidebar.panellist exact contract PASS(契约测试)
- [x] main exact contract PASS(契约测试)
- [x] selectPanel / null PASS(契约测试 + 委派断言)
- [x] conversation/session 不受破坏(session list/page + WS reconnect + restart)
- [x] `ctx.tools?.guard` 猜测调用已删除
- [x] sdk-driver 无 production TODO path
- [x] `__DSH_BOOT__` 证明新 artifact 被加载
- [x] install / build / typecheck / test PASS
- [x] HTTP / WS / launch-token / restart 回归 PASS

并继续记录:

```text
REAL_BROWSER_REFRESH_E2E = REQUIRED_BEFORE_CANARY_CUTOVER
```

**完成后立即停止,不进入 Phase 03。**
