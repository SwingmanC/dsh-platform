# REWORK-02C — dsh 0.1.5-rc.2 Client Plugin 契约(实测固定)

> 来源:**固定 tag `dsh-v0.1.5-rc.2`** 官方源码 + 已发布 `lib/*.d.ts` 与 `lib/client.js`。
> 本地权威副本:`.tools/dsh-0.1.5-rc.2/node_modules/@deepseek-ai/*`。
> 本文件只记录 exact contract,不采用任何 02B 报告中的示意代码。

---

## 1. Plugin package exports / client entry / dsh.client metadata

官方样例 `packages/client/ui-sidebar/package.json`:

```json
{
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": {
      "inject": [
        "@deepseek-ai/dsh-api-workspace-controller",
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-session",
        "@deepseek-ai/dsh-client-ui-workspace",
        "@deepseek-ai/dsh-client-locale"
      ],
      "platform": "web"
    }
  }
}
```

| 项 | 官方 source path | 类型 / 值 | 本项目采用 |
|---|---|---|---|
| client entry 源 | `packages/client/ui-sidebar/tsdown.config.ts` → `clientBundle(id, ...)` → `entry: src/client/index.ts` | tsdown 配置 | `packages/cmcc-platform-ui/src/client/index.tsx` |
| client 产物 | `packages/client/tsdown.client.ts` `clientConfig` | `outDir: lib`,`entryFileNames: 'client.js'`,`format: cjs`,`platform: browser` | `lib/client.js` |
| `dsh.client.inject` | `packages/client/*/package.json` | `string[]`(包名依赖边,供 factory arrival + 插件组合) | `['@deepseek-ai/dsh-client-ui-renderer','@deepseek-ai/dsh-client-ui-layout']` |
| `dsh.client.platform` | 同上 | `'web'` | `'web'` |
| `dsh.client.external` | `packages/client/tsdown.client.ts` `requestedExternals()` | `string[]`(额外 module-table 请求;baseline 之外才需声明) | 不声明(只用 baseline) |

## 2. Bundle 包装格式(exact)

`packages/client/tsdown.client.ts` `clientConfig().outputOptions`:

```js
banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
intro:  'var module = { exports: {} }; var exports = module.exports;',
footer: 'return module.exports; } });'
```

已发布 `dsh-client-ui-sidebar/lib/client.js` 首行实测:

```js
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-client-ui-sidebar",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    ...
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
```

- `id` **必须等于包名**(registration key 必须匹配 boot graph row)。
- factory 内 `require(spec)` 解析 module table(不是 Node require)。
- 插件模块导出 `apply` / `inject`(cordis 插件面)。

## 3. Module table baseline(可 `require` 的 specifier)

`packages/client/web/src/platform.ts` `PLATFORM_MODULES`:

```text
react
react/jsx-runtime
react-dom
react-dom/client
@deepseek-ai/cordis
@deepseek-ai/dsh-client-store
@deepseek-ai/dsh-client-ui-slots
@deepseek-ai/dsh-client-ui-primitives
@deepseek-ai/dsh-client-ui-dockkit
```

其余 `@deepseek-ai/*` 值导入会被 bundle purity gate 拒绝;跨插件协作必须走 cordis service。
→ 本插件运行时只 `require('react')` / `require('react/jsx-runtime')`;`ctx.slots` / `ctx.layout` 走 cordis service,**不 import**。

## 4. Cordis service / inject

| 项 | 官方 source path | 签名 | 本项目 |
|---|---|---|---|
| module `inject` | `ui-sidebar/src/client/index.ts` | `export const inject = ['slots','layout',...]`(cordis service 名) | `['slots','layout']` |
| `dsh.client.inject` | `ui-sidebar/package.json` | 包名依赖边 | ui-renderer / ui-layout |
| `ctx.slots` | `dsh-client-ui-renderer/client`(service 合并) | `register()` / `inject()` / `entriesOfSlot()` / `subscribe()` | 使用 `inject`+`register` |
| `ctx.layout` | `dsh-client-ui-layout/lib/types/client/index.d.ts` | `ILayout`(`selectPanel`/`toggleSidebar`/...) | 使用 `selectPanel` |

## 5. Slot registration API(exact)

`packages/client/ui-slots/src/index.ts`:

```ts
ctx.slots.register(options, component): () => void
ctx.slots.inject(slotKey, () => ctx.slots.register(...))   // 亦支持 generator 形式
```

`register` options(`BaseOptions` + `KindOptions`):

```ts
{
  name: string          // 目标 slot key(必填)
  children?: ChildrenDecl
  store?: H
  locale?: N
  registrant?: string
  // keyed:  { key, priority? }
  // list:   { id, order?, label?, priority? }
  // chain:  { select, priority? }
  // single: { priority? }
}
```

- 声明即占用(declaring = claiming);向未声明 slot 注册会 throw。
- 同一 cell 同 priority 二次注册会 throw;不同 priority 可 shadow(低者渲染)。

## 6. `sidebar.panellist`(list / root)

`packages/client/ui-sidebar/src/client/contract/slots.ts`:

```ts
'sidebar.panellist': { kind: 'list'; scope: 'root'; owner: SidebarPanelIconOwnerProps }
interface SidebarPanelIconOwnerProps { size: number; active: boolean }
```

- 每个 list id 对应同名 main panel;sidebar 用 `entriesOfSlot('sidebar.panellist')` 读 `options.id/order/label`,`resolveSlotLabel(options.label)` 解析 label。
- 注册:`ctx.slots.register({ name: 'sidebar.panellist', id, order, label }, IconComponent)`。

## 7. `main` keyed slot / MainPanelId

`packages/client/ui-layout/lib/types/client/index.d.ts`:

```ts
'main': { kind: 'keyed'; scope: 'root' }   // 保留 key: 'conversation'
```

`packages/client/ui-conversation/lib/client.js` 实测:

```js
slots.inject("main", function* () {
  yield slots.register({ name: "main", key: "conversation", children: { "main.conversation": { kind: "single", scope: "session-maybe" } } }, ConversationPanel);
  ...
});
```

- 注册:`ctx.slots.register({ name: 'main', key: 'cmcc.smoke' }, PanelComponent)`。

## 8. `MainPanelId` / `selectPanel` / `usePanelInfo`

`packages/client/ui-layout/src/client/service.ts`:

```ts
export type MainPanelId = Branded<'MainPanelId'>
export interface PanelInfo { readonly activePanelId: MainPanelId | null }
export interface ILayout {
  selectPanel(panelId: MainPanelId | null): void   // null → 显示 Conversation;未注册 key → throw
  beginNavigation(): AbortSignal
  toggleSidebar(): void
  openRightbar(track: boolean, fullscreen: boolean): void
  closeRightbar(): void
}
```

`packages/client/ui-layout/src/client/index.ts`:

```ts
export type UsePanelInfo = SnapshotSelectorHook<PanelInfo>
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps { usePanelInfo: UsePanelInfo }   // 每个 slot 组件都能拿到
}
```

## 9. conversation panel key / null 语义

- `main` 保留 key = `'conversation'`,由 `ui-conversation` 注册。
- `ctx.layout.selectPanel(null)` → `activePanelId = null` → 渲染 conversation;`selectPanel('cmcc.smoke')` → 渲染本插件 panel。
- 切换 panel **不改变当前 Session**(`selectPanel` 注释:"without changing the current Session")。

## 10. 组件 props 组合(四 share)

`ComposedProps = PropsRuntime & PropsRenderSlots & PropsStore & InjectFace & MatchedShare & PropsLocale`。

- `PropsRuntime<K>` 含 `OwnerOf<K>`(list: `{size,active}`;keyed main: `{}`)+ `GlobalStandardProps`(`usePanelInfo`)。
- `inject` 业务面:root scope 的 `InjectParams = []`,即 `inject: () => I`,返回值作为组件 props。

---

## 11. 本项目固定结论

- client entry = `src/client/index.tsx` → 官方包装 → `lib/client.js`。
- 运行时 require 仅 `react` / `react/jsx-runtime`(baseline)。
- 通过 `ctx.slots.inject` + `ctx.slots.register` 注册 `sidebar.panellist`(id=`cmcc.smoke`)与 `main`(key=`cmcc.smoke`)。
- 通过 `ctx.layout.selectPanel` 回 conversation;组件经 `usePanelInfo` 读 active panel。
- 不使用 React Router / `window.location.href` / iframe / querySelector / MutationObserver。
