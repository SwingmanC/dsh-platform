# REWORK-03 — 中国移动能力中心 + 四个正式全局 Panel(结果报告)

> 完成日期:2026-09-18
> 前置:`REWORK-02C-plugin-contract-result.md` = `GO_TO_PHASE_03`
> 固定 tag:`dsh-v0.1.5-rc.2`
> Runtime:Node `v24.11.0`,0.1.5-rc.2 沙箱,launch-token Gateway bootstrap,canary DSH_HOME

---

## 结论:`GO_TO_PHASE_04`

四个正式全局能力入口已在 DSH 原生 Shell 内注册并调用真实平台 API;Runtime Provider/Adapter 缺口如实展示。
链路:**sidebar.panellist ×4 ↔ main keyed ×4 → PlatformApiClient → Gateway REST → MySQL**。

**未执行(生产 Canary 前 blocker,非 03 blocker):**

```text
REAL_BROWSER_REFRESH_E2E = NOT_EXECUTED
REAL_BROWSER_REFRESH_E2E = REQUIRED_BEFORE_CANARY_CUTOVER
```

---

## 1. Sidebar registration(`sidebar.panellist`,list/root)

| id | label | order |
|---|---|---|
| `cmcc.skills` | 技能广场 | 100 |
| `cmcc.knowledge` | 知识中心 | 110 |
| `cmcc.mcp` | MCP 服务 | 120 |
| `cmcc.memory` | 我的记忆 | 130 |

- 契约测试断言 4 项 exact options(`tests/client-contract.test.mjs`)。
- `cmcc.smoke` **不再注册**;测试断言其不存在于 bundle。

## 2. Main keyed panel registration(`main`,keyed/root)

- 4 个 key:`cmcc.skills` / `cmcc.knowledge` / `cmcc.mcp` / `cmcc.memory`。
- 契约测试断言 **sidebar id 集合 == main key 集合**。
- 不覆盖保留 key `conversation`。

## 3. Conversation / Session 返回语义

- 能力入口点击由 DSH 原生 sidebar 调 `ctx.layout.selectPanel(id)`,**不改变当前 Session**。
- 本插件不维护第二份 activePanel state;面板「返回会话」经 `selectPanel(null)` 回 Conversation。
- 回归:切换 panel 后 `session/list` + `session/page` 仍正常(见 §15)。

## 4. Skill Panel

- 真实 `GET /api/skills`(搜索)+ `GET /api/skills/installed`。
- 真实 mutation:`POST /api/skills`(创建)、`/publish`、`/install`、`DELETE /install`。
- 展示平台状态(草稿/已发布/已安装/可见性);Runtime 徽章 = **未接入**。

## 5. Knowledge Panel

- 真实 `GET /api/knowledge-bases` + `/api/knowledge/mounts`。
- 真实 `POST /api/knowledge-bases`、`POST /:id/mount`、`GET /:id/documents`。
- 真实平台检索 `GET /api/knowledge/search?q=`(chunks 为空 → 真实 empty「暂无匹配结果」,不注入示例)。
- 缺口如实展示:文档上传 `NOT_IMPLEMENTED`、Ingestion `NOT_IMPLEMENTED`、RAG `RUNTIME_NOT_CONNECTED`。

## 6. MCP Panel

- 真实 `GET /api/connectors` + `/api/connectors/authorized`。
- 真实 `POST /api/connectors`、`/approve`、`/authorize`。
- 缺口如实展示:MCP Projection / Agent Tools / Tool Trial API 未接入;授权 ≠ Agent 已获工具。

## 7. Memory Panel

- 真实 `GET /api/memory` + `/api/memory/namespaces`。
- 真实 `POST /api/memory`、`DELETE /:id`、`POST /:id/promote`。
- 缺口如实展示:自动提取 / 跨 Session Recall / Injection 未接入。

## 8. PlatformApiClient

- `packages/cmcc-platform-ui/src/client/platform-api.ts`:集中封装 23 个现有 endpoint。
- 读写分离(GET 无 CSRF;写带 `x-csrf-token`);`credentials: include`;错误归一 `PlatformApiError`。
- **不传身份字段**:测试断言请求中无 `userId/tenantId/ownerId`。
- 详见 `REWORK-03-platform-api-client.md`。

## 9. Loading / Empty / Error

- 统一 `ResourceState = loading | ready | empty | error`(纯状态机,可测)。
- 每个面板:loading 文案、真实 empty、error + 重试按钮;错误文案用户可读,不含 stack/SQL/token。
- 测试覆盖 loading/ready/empty/error(`tests/models.test.ts`)。

## 10. Mutations

- 所有按钮:`点击 → pending/disabled → 真实 API → 成功重新读取服务端 → 失败可见`。
- 模型层 `*AndReload` 保证 mutation 后重新拉取;测试断言调用顺序(mutation → list)。
- 实测(HTTP,见 §11):publish/install/mount/approve/authorize/delete 全部 200 并反映到后续读取。

## 11. Tenant / User isolation(HTTP 实测)

对运行中 Gateway(admin=default 租户,userb=tenant-b):

| 检查 | 结果 |
|---|---|
| admin 建私有 skill / personal KB / memory | 201 |
| userb 列表看不到 admin 私有 skill / KB / memory / connector | 全部 false |
| admin 看不到 userb 私有 skill | false |
| admin 直取 userb 私有 skill | **404** |

- 列表 endpoint 8/8 返回 200 真实数据。
- mutation:skill publish/install 200 + installed 含;KB mount 200 + mounts 含;connector create/approve/authorize 200 + authorized 含;memory delete 200 + 再取 404。

## 12. Brand

- 注册 `sidebar.brand.mark` / `sidebar.brand.name`(priority -1,shadow 官方默认)。
- 文字 mark「移」+「中国移动 · 数智智能体平台」;未下载外部 Logo;未改 DSH core theme。

## 13. Portal legacy status

- Portal 源码保留,标记 `LEGACY_UI`;普通用户主体验转向 DSH,入口不再指向 Portal 页面。
- 保留 `/login`、error、auth callback。
- 物理删除留到最终收口 Phase。本阶段未删除任何 Portal 源码。

## 14. `__DSH_BOOT__` evidence

运行中 Gateway 实测 boot graph(两次,含 restart 后):

```text
entries=55
@dsh-platform/dsh-bridge        PRESENT  inject=["@deepseek-ai/dsh-client-ui-renderer"]
@dsh-platform/cmcc-platform-ui  PRESENT  inject=["...ui-renderer","...ui-layout"]
skill-plaza / knowledge-base / connector  ABSENT
```

- 拉取 `cmcc-platform-ui/client.js`:HTTP 200,**59660 bytes**,`__ModuleLoader__.load`=true,
  含 `cmcc.skills` / `cmcc.knowledge` / `cmcc.mcp` / `cmcc.memory`,**不含 `cmcc.smoke`**。
- `dsh-bridge/client.js`:200,4067 bytes。
- 证明加载的是 03 新构建 artifact,legacy modal 未重新进入。

## 15. Regression

| 命令 | 结果 |
|---|---|
| `pnpm install --frozen-lockfile` | **EXIT 0** |
| `pnpm build` | **EXIT 0** |
| `pnpm typecheck` | **EXIT 0** |
| `pnpm test` | **EXIT 0**(dsh-bridge 1 + cmcc-platform-ui 18 + gateway 39 = 58 pass) |
| launcher preflight | `dsh launcher ok: node=v24.11.0 dsh=0.1.5-rc.2` |
| Runtime start | PASS |
| launch-token bootstrap | 303 + Location `/`(无 token) |
| clean root | 200(28298 bytes) |
| HTTP / WS | health 200;WS upgrade/reconnect PASS |
| Session list/open | 200 |
| Runtime restart | kill dsh → 重新 spawn → 303 → boot graph 仍含两插件 |
| boot graph | 两平台插件 PRESENT,legacy ABSENT |

**Gateway 路由修复(必要,非 auth 重写):** dsh UI authority 下平台 `/api/*` 由精确 path 白名单改为**前缀匹配**(`PLATFORM_API_PREFIXES`),使 shell 内面板可调用子资源路由(`/api/skills/:id/install`、`/api/connectors/:id/authorize`、`/api/knowledge/mounts`、`/api/memory/:id`)。dsh 自身用单数 `/api/session/*`,不冲突。

## 16. REAL_BROWSER_REFRESH_E2E

```text
REAL_BROWSER_REFRESH_E2E = NOT_EXECUTED
REAL_BROWSER_REFRESH_E2E = REQUIRED_BEFORE_CANARY_CUTOVER
```

- 本机无浏览器;Panel 切换/渲染用 bundle 契约测试 + boot graph + live HTTP 等价验证。
- **不宣称视觉 E2E PASS**。

## 17. Modified files

### 新增
| 文件 | 说明 |
|---|---|
| `packages/cmcc-platform-ui/src/client/platform-api.ts` | PlatformApiClient |
| `packages/cmcc-platform-ui/src/client/capability-status.ts` | Runtime 能力声明 |
| `packages/cmcc-platform-ui/src/client/models/{types,resource,skills,knowledge,mcp,memory}.ts` | DTO/状态机/四域 model |
| `packages/cmcc-platform-ui/src/client/components/{PanelShell.tsx,hooks.ts}` | 共用 UI + hooks |
| `packages/cmcc-platform-ui/src/client/panels/{registry.tsx,SkillPanel,KnowledgePanel,McpPanel,MemoryPanel}.tsx` | 四 Panel |
| `packages/cmcc-platform-ui/tests/{client-contract.test.mjs,platform-api.test.ts,models.test.ts}` | 测试 |
| `docs/implementation/REWORK-03-{panel-architecture,platform-api-client,four-panels-result}.md` | 文档 |

### 修改
| 文件 | 变更 |
|---|---|
| `packages/cmcc-platform-ui/src/client/index.tsx` | 注册 4 sidebar + 4 main + 品牌;移除 cmcc.smoke |
| `packages/cmcc-platform-ui/package.json` | +tsx;test 脚本含 .ts |
| `apps/gateway/src/index.ts` | 平台 API 前缀路由界定(dsh authority) |
| `pnpm-lock.yaml` | cmcc tsx 依赖 |

## 18. Remaining Runtime gaps

```text
Skill Runtime Projection     = NOT_CONNECTED
Knowledge Runtime Adapter    = NOT_CONNECTED
MCP Runtime Projection       = NOT_CONNECTED
Memory Runtime Adapter       = NOT_CONNECTED
```

- 由 `capability-status.ts` 声明(build capability declaration,**非 runtime health**),UI 以徽章如实展示。
- Phase 04–07 替换为真实 runtime evidence。

## 19. Final Decision

```text
GO_TO_PHASE_04
```

满足 §25 全部条件:

- [x] cmcc.smoke 不再作为普通用户入口
- [x] cmcc.skills / cmcc.knowledge / cmcc.mcp / cmcc.memory 注册 PASS
- [x] 四个 main keyed panel PASS
- [x] Session/Workspace → Conversation 行为不受破坏
- [x] 四 Panel 只使用真实平台数据
- [x] 无 fake/mock/sample 生产数据
- [x] mutation 走真实 API
- [x] loading/empty/error 完整
- [x] tenant/user UI/API 隔离不倒退
- [x] legacy modal UI 不重新进入 boot graph
- [x] install/build/typecheck/test PASS
- [x] HTTP/WS/bootstrap/restart PASS

完成后立即停止,不进入 Phase 04–07。
