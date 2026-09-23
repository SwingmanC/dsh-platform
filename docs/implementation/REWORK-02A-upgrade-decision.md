# REWORK-02A — Upgrade Decision

> 审计日期:2026-09-16
> 目标:`DeepSeek Harness 0.1.5-rc.2`(tag `dsh-v0.1.5-rc.2`)
> 结论:**GO_WITH_BLOCKERS**

---

## 决策摘要

**GO_WITH_BLOCKERS。** 0.1.5-rc.2 的全局面板 API 已从固定 tag 源码逐行确认,完全满足"左栏能力中心 + 中央 Main Panel"的产品目标;本机 Node 满足引擎要求。但存在 4 个必须先解决的阻塞项(见 §8),因此**不得直接升级主环境**,须在独立分支按 02B 逐项验证。

---

## 1. 全局面板 API(从 tag 源码确认,禁止猜)

### 1.1 `main` slot(keyed)

文件:`packages/client/ui-layout/src/client/index.ts`

```ts
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar': { kind: 'single'; scope: 'root'; owner: SidebarOwnerProps }
    'main':    { kind: 'keyed';  scope: 'root' }
    'rightbar':{ kind: 'single'; scope: 'root'; owner: RightbarOwnerProps }
    'shell.overlay': { kind: 'list'; scope: 'root' }
  }
}
```

> 中央面板由 sidebar entry id 选中。保留 key `conversation` 承载会话;其他 key 不接收 Session 绑定。

`main` 是 **keyed** slot,key 来自注册项的 `options.key`(源码 `retainMainPanels` 使用 `entry.options.key`)。

### 1.2 `sidebar.panellist`(list)

文件:`packages/client/ui-sidebar/README.zh.md`

> 插件在 root 作用域的 `sidebar.panellist` **list** 中注册图标组件,提供 `id`、可选 `order`,以及字符串或随语言变化的 `label`。同一个 id 寻址布局中 root 作用域 `main` keyed slot 的组件;选择不存在的主面板条目会抛错,并保留当前选中态。每一行通过 `usePanelInfo` 读取自己的选中态。

### 1.3 `ctx.layout` 服务(`ILayout`)

文件:`packages/client/ui-layout/src/client/service.ts`

```ts
export type MainPanelId = Branded<'MainPanelId'>

export interface PanelInfo {
  /** Selected global panel; null displays the current Conversation. */
  readonly activePanelId: MainPanelId | null
}

export interface ILayout {
  /** Select a global central panel without changing the current Session.
   *  @throws if the selected main key is not registered; preserves the current selection. */
  selectPanel(panelId: MainPanelId | null): void
  /** Start an asynchronous navigation; @returns an AbortSignal. */
  beginNavigation(): AbortSignal
  toggleSidebar(): void
  openRightbar(track: boolean, fullscreen: boolean): void
  closeRightbar(): void
}
```

### 1.4 `usePanelInfo`(全局标准 prop)

文件:`packages/client/ui-layout/src/client/index.ts`

```ts
export type UsePanelInfo = SnapshotSelectorHook<PanelInfo>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps {
    usePanelInfo: UsePanelInfo
  }
}
```

### 1.5 注册范式(由上述契约推导)

```ts
// 左栏入口(list):id 寻址 main keyed slot
ctx.slots.inject('sidebar.panellist', () =>
  ctx.slots.register({
    name: 'sidebar.panellist',
    id: 'cmcc.skills',
    order: 100,
    label: '技能广场',            // string | 随 locale 变化
  }, SkillIcon))

// 中央面板(keyed):key = panellist 的 id
ctx.slots.inject('main', () =>
  ctx.slots.register({
    name: 'main',
    key: 'cmcc.skills',
  }, SkillPanel))

// 切换(不改变当前会话)
ctx.layout.selectPanel('cmcc.skills')   // 选中
ctx.layout.selectPanel(null)            // 回到 conversation
```

### 1.6 其他确认

- `packages/client/ui-layout/src/client/index.ts` 的 `apply` 通过 `ctx.slots.register({ name:'root', children:{...} }, AppFrame)` 声明四个 child slot;`ctx.reflect.provide('layout', layout)` 暴露服务。
- `inject = ['slots', 'theme', 'locale']`(client fiber)。
- `ctx.slots.provideRoot({ hooks: { panelInfo } })` 提供 `usePanelInfo`。
- 组件**绝不接收 `ctx`**;业务状态留在 service/model,slot store 只承载视图交互状态。

---

## 2. Session V2 → V3 预检

### 2.1 迁移机制

文件:`packages/session/session-format-v2-to-v3/README.zh.md`

- 包:`@deepseek-ai/dsh-session-format-v2-to-v3`;持久化通过 `session-format-catalog` 自动恢复,**不读取/发布文件**由本库负责。
- 逻辑头 `version: 2 → 3`,保留 `id`/`createdAt`/`isSeeded`/`delegationDepth`/`cwd`/`parentSession`/`origin`。
- 主要变换:系统提示词提升为 `system/message` 头节点、本地事件引用重映射、PTC 词汇(`tools-code-mode`→`tools-ptc`)、预设标识 `code`→`ptc`、信封规范化。
- **保留**:相对顺序、时间戳、历史请求含义。
- **拒绝**(抛 `SessionFormatUnsupportedMigrationError`):未知事件/未审计成员、PTC 前代标签、不一致切点、投递违规、矛盾工具结果。拒绝时**保留源字节,不发布后继代**。

### 2.2 迁移风险

- 迁移**不是恒等变换**:会插入系统事件,改变事件数、稠密序列位置、本地引用与继承切点。
- 平台侧只持有 `t_dsh_agent_bindings`(session_id → user/workspace),**不解析 JSONL**;因此迁移对平台 DB 无影响,但会影响"历史会话可恢复性"。
- 有种子 Session(`session/end-seed` + `inherited:true`)的切点计算有专门规则。

### 2.3 预检准备(02B 执行,本阶段只规划)

必须准备**一次性测试 DSH_HOME**,至少包含:
- 1 个正常 Session
- 1 个长 Session
- 1 个含取消/中断历史的 Session(若存在)

**禁止用唯一原件直接升级**。现有 `var/homes/<tenant>/<user>/storages` 中的真实会话须先备份。

---

## 3. 迁移演练矩阵(02B 执行)

| 项 | 0.1.1-rc.2(现状) | 0.1.5-rc.2(目标) | 待验证 |
|---|---|---|---|
| 启动 | ✅ 实测 | 待测 | `dsh web` 启动行格式 |
| workspace list | ✅ | 待测 | 持久化结构是否兼容 |
| session list | ✅ | 待测 | V2 会话是否被自动迁移 |
| 打开旧 session | ✅ | 待测 | 迁移是否无损 |
| 新建 session | ✅ | 待测 | V3 写入 |
| prompt | 未验证(SDK 未接) | 待测 | |
| resume | 未验证 | 待测 | |
| WebSocket reconnect | 未验证 | 待测 | |
| plugin boot | ✅ boot 清单含平台插件 | 待测 | 新契约下 client 是否加载 |

---

## 4. 0.1.5 破坏面(需逐项验证)

| 面 | 现状(0.1.1) | 0.1.5 变化 | 影响 |
|---|---|---|---|
| Agent plugin API | `ctx.tools?.guard`(猜测) | 需重读 | `dsh-bridge` host |
| Session format | V2 | **V3** | 历史会话迁移 |
| Client slot API | `sidebar.footer.action` 存在 | 新增 `sidebar.panellist`/`main`;slot 代数可能变化 | 全部 4 个 client 插件 |
| Client import paths | `require('react')` 等 | 需重读 | client bundle |
| Cordis Context import | `@deepseek-ai/cordis` | `^4.0.2`(与现状 `4.0.2` 一致) | 低风险 |
| Remote API | `@deepseek-ai/dsh-api-remotes` | 版本号升到 `^0.1.5-rc.2` | 需重读 |
| Workspace/Session Controller | — | 需重读 | 平台 reconcile 逻辑 |
| MCP client | 未使用 | `@deepseek-ai/dsh-mcp-client@^0.1.5-rc.2` | Phase 05 |
| Skills subsystem | 未使用 | `ctx.skills`(分层注册表) | Phase 04 |

**注意:** 0.1.1 的 sidebar slots 为 `brand.mark`/`brand.name`/`footer.action`/`settings`/`workspaces`;0.1.5 新增 `panellist`,并引入 `main`/`rightbar`/`shell.overlay`。需确认 0.1.5 是否**仍保留** `footer.action` 等旧 slot,否则现有 client bundle 会失效。

---

## 5. 当前平台插件逐个审计

| 插件 | host | client src | client bundle | 双真源问题 |
|---|---|---|---|---|
| `@dsh-platform/dsh-bridge` | `dist/host.js`(编译自 `src/host.ts`,用**猜测 API** `ctx.tools?.guard`) | `src/client.ts`(手写,`sidebar.footer.action`) | `client.bundle.js`(手写,内容≈src) | ⚠️ src 与 bundle 手工同步 |
| `@dsh-platform/dsh-skill-plaza` | `host.js` **空** | `src/client.ts` **apply 为空** + 无效 React 用法 | `client.bundle.js`(手写 modal) | ❌ src 是死占位 |
| `@dsh-platform/dsh-knowledge-base` | `host.js` **空** | `src/client.ts` **apply 为空** | `client.bundle.js`(手写 modal) | ❌ src 是死占位 |
| `@dsh-platform/dsh-connector` | `host.js` **空** | `src/client.ts` **apply 为空** | `client.bundle.js`(手写 modal) | ❌ src 是死占位 |

**package.json 契约:**
- 3 个 UI 包:`main: ./host.js`(空)、`exports["./client"]: ./client.bundle.js`(手写)、`dsh.client.inject: []`。
- `dsh-bridge`:`main: ./dist/host.js`、`exports["./client"]: ./client.bundle.js`。

**必须修复的双真源问题:**
- 目标链路:`src/client.ts → typecheck/build(tsdown) → lib/client.js → Runtime`。
- 现状:`src` 是占位,bundle 手工维护,两者不同步 → 任何 `src` 修改都不会生效。
- 02B/03 必须先建立真实构建管道,删除手写 bundle,或让 bundle 成为构建产物。

---

## 6. Node / pnpm

| 项 | 本机 | 0.1.5-rc.2 要求 | 结论 |
|---|---|---|---|
| Node | `v24.0.0` | `^22.19.0 \|\| >=24.0.0` | ✅ |
| pnpm | `12.4.1` | 官方开发用 `11.7.0` | ⚠️ 本机更高;平台自身 workspace 不受 dsh 影响,但需验证 `pnpm install` dsh 相关包无异常 |
| TypeScript(平台) | `^5.6.0` | 官方 dev `^6.0.3` | ✅ 平台不编译 dsh 源码 |

---

## 7. 升级方案(02B 执行,不在本阶段)

1. 新建分支 `feat/dsh-0.1.5-panel-integration`(不得在主分支升级)。
2. 备份 `var/homes`(至少 `storages`)与 `db`。
3. 复制/生成一次性测试 DSH_HOME(Session fixtures)。
4. 安装 `@deepseek-ai/dsh@0.1.5-rc.2`(全局或平台私有),`dsh --version` 确认。
5. 逐项跑迁移演练矩阵(§3)。
6. 用 tag 源码重建 4 个平台插件的 host/client 契约(§5),建立真实构建管道。
7. 更新 `dsh-bridge` 依赖到 `0.1.5-rc.2`。
8. 单 Origin 路由:`/login`→平台、`/platform-api/*`→平台、其余→DSH Runtime(见 START-HERE-NEXT §最终产品壳)。
9. 全绿后灰度。

---

## 8. 阻塞项(必须先解决)

| # | 阻塞项 | 说明 | 解除条件 |
|---|---|---|---|
| B1 | 平台插件双真源 | `src/client.ts` 占位,`client.bundle.js` 手工维护 | 建立 `src → build → bundle` 管道 |
| B2 | 插件契约未知 | 现有 client 使用 0.1.1 的 `sidebar.footer.action`;0.1.5 slot 代数变化未验证 | 用 0.1.5 tag 源码重写并实测加载 |
| B3 | Session 迁移未演练 | V2→V3 自动迁移有拒绝规则;真实会话未备份 | 一次性 home 演练全绿 |
| B4 | `sdk-driver` 版本漂移 | peer 声明 `0.1.2-rc.1` 与实际不符 | 统一到 `0.1.5-rc.2` 或移除 |
| B5 | host 侧 API 未验证 | `dsh-bridge` 用猜测 `ctx.tools?.guard` | 用 0.1.5 源码确认 guard/tool 扩展点 |
| B6 | pnpm 版本差异 | 本机 `12.4.1` vs 官方 `11.7.0` | 验证 dsh 包安装/启动无异常 |

---

## 9. 02B 前置条件

- [ ] 本报告确认 GO_WITH_BLOCKERS
- [ ] 新建迁移分支
- [ ] 备份 `var/homes` + `db`
- [ ] 准备一次性测试 DSH_HOME(Session fixtures)
- [ ] 明确 B1–B6 的解除顺序
- [ ] **未获确认前不得升级主环境**

---

## 结论

**GO_WITH_BLOCKERS。** 目标 API 可行且已从源码确认,但必须先在独立分支解决 B1–B6,并在一次性环境完成 Session 迁移演练与插件契约实测后,才能进入主环境切换。
