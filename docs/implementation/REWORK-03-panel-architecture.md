# REWORK-03 — 四 Panel 架构(中国移动能力中心)

> 前置:`REWORK-02C-plugin-contract-result.md` = `GO_TO_PHASE_03`
> 固定 tag:`dsh-v0.1.5-rc.2`
> 目标:在 DSH 0.1.5 原生 Shell 内提供四个正式全局能力入口,不实现 Runtime Provider/Adapter。

---

## 1. Slot 注册

包:`@dsh-platform/cmcc-platform-ui`(client bundle:官方 `__ModuleLoader__.load` 包装)。

### 1.1 `sidebar.panellist`(list / root)

| id | label | order |
|---|---|---|
| `cmcc.skills` | 技能广场 | 100 |
| `cmcc.knowledge` | 知识中心 | 110 |
| `cmcc.mcp` | MCP 服务 | 120 |
| `cmcc.memory` | 我的记忆 | 130 |

```ts
ctx.slots.inject('sidebar.panellist', () => PANELS.map((p) =>
  ctx.slots.register({ name: 'sidebar.panellist', id: p.id, order: p.order, label: p.label }, p.Icon)))
```

### 1.2 `main`(keyed / root)

```ts
ctx.slots.inject('main', () => PANELS.map((p) =>
  ctx.slots.register({ name: 'main', key: p.id }, p.Component)))
```

- `sidebar id == main key`(契约测试断言两集合相等)。
- **不覆盖** `conversation`(保留 key 由 ui-conversation 注册)。

### 1.3 品牌槽(shadow 官方默认)

```ts
ctx.slots.register({ name: 'sidebar.brand.mark', priority: -1 }, CmccBrandMark)
ctx.slots.register({ name: 'sidebar.brand.name', priority: -1 }, CmccBrandName)
```

- 更低 priority 渲染 → shadow 官方 `ui-brand-official` 默认。
- 文字 mark(未授权 Logo 不下载);文案「中国移动 · 数智智能体平台」。

### 1.4 `cmcc.smoke` 退役

- 不再注册;契约测试断言 bundle 中不存在 `cmcc.smoke` 入口。
- 仅保留为历史契约测试的对照 id。

## 2. Conversation / Session 返回语义

- 能力入口点击由 **DSH 原生 sidebar** 调 `ctx.layout.selectPanel(id)`;本插件**不维护**第二份 activePanel state。
- `ctx.layout.selectPanel(id)` 只切换 global main panel,**不改变当前 Session**(官方 `ILayout.selectPanel` 语义)。
- 点击 DSH 原生 Session/Workspace 导航 → 官方 `selectPanel(null)` → 回 Conversation。
- 本插件面板的「返回会话」按钮经 register `inject` 工厂拿到 `selectPanel`,调 `selectPanel(null)`。

## 3. 目录结构

```text
packages/cmcc-platform-ui/src/client/
  index.tsx                  apply:4 sidebar + 4 main + brand
  platform-api.ts            PlatformApiClient(集中封装)
  capability-status.ts       Runtime 能力声明(构建期,非 health)
  models/
    types.ts                 API DTO 镜像
    resource.ts              loading/ready/empty/error 状态机(纯函数)
    skills.ts knowledge.ts mcp.ts memory.ts   各域 load + mutation+reload
  components/
    PanelShell.tsx           PlatformPanel/PanelHeader/Toolbar/Content/Loading/Empty/Error/RuntimeStatusBadge
    hooks.ts                 useAsyncState / useMutation
  panels/
    registry.tsx             PANELS(4)
    SkillPanel.tsx KnowledgePanel.tsx McpPanel.tsx MemoryPanel.tsx
```

## 4. 组件纪律

- React 组件**不接收 Cordis ctx**;数据经 `PlatformApiClient` 单例,动作经 register `inject` 工厂(本阶段面板无跨插件动作,品牌/入口由框架回调)。
- 不散落 `fetch('/api/...')`;统一经 `platformApi`。
- 无 iframe / DOM querySelector / MutationObserver / React Router / `window.location` 能力导航。
- 无第二套 Conversation UI。

## 5. Runtime 能力状态模型

`capability-status.ts`(构建期声明,**不是 runtime health**):

| 能力 | platform | runtime |
|---|---|---|
| skill | PLATFORM_READY | RUNTIME_NOT_CONNECTED |
| knowledge | PLATFORM_READY | RUNTIME_NOT_CONNECTED |
| mcp | PLATFORM_READY | RUNTIME_NOT_CONNECTED |
| memory | PLATFORM_READY | RUNTIME_NOT_CONNECTED |

- UI 以 `RuntimeStatusBadge` 如实展示「Runtime 未接入」并列出 gaps。
- 不允许把 DB 状态冒充 Runtime 已生效。
- Phase 04–07 再替换为真实 runtime evidence。

## 6. Brand

- 复用官方 `sidebar.brand.mark` / `sidebar.brand.name` 槽。
- 文字 mark;不改 DSH core theme;不下载外部 Logo。

## 7. Portal 状态

- Portal 源码保留,标记 `LEGACY_UI`;普通用户入口不再指向 Portal Dashboard/Sessions/Workspaces/Skills/Knowledge/MCP/Memory。
- 保留 `/login`、error、auth callback。
- 物理删除留到最终收口 Phase。

## 8. 已知偏差 / follow-up

1. **CSS Modules / ui-primitives**:官方 client 构建用 tsdown + lightningcss + `@deepseek-ai/dsh-client-ui-primitives`;本项目用 esbuild + inline style + DSH 语义 token(`--dsw-alias-*`)。`ui-primitives` 未随 Runtime 沙箱安装,无法核对组件 API,故本阶段不复用其组件。记为 follow-up。
2. **真实浏览器渲染未验证**:`REAL_BROWSER_REFRESH_E2E = REQUIRED_BEFORE_CANARY_CUTOVER`。
3. `/api/*` → `/platform-api/*` namespace 迁移记为 follow-up(本阶段集中封装现有 endpoint)。
