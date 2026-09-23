# REWORK-01 — Shell Gap Report

> 审计日期:2026-09-16
> 分层枚举:UI_ONLY | API_MISSING | SERVICE_MISSING | DB_MISSING | RUNTIME_PROJECTION_MISSING | PLUGIN_NOT_COMPOSED | AUTH_MISSING | VERSION_INCOMPATIBLE

---

## 1. 问题分层

### UI_ONLY
- Portal `DashboardPage` 的能力卡 + "我的工作"统计卡:纯展示,无独立业务价值(数据来自各 API,但页面本身是多余的一层壳)。
- Portal 侧栏导航(首页/会话/工作区/能力中心/个人能力):与 DSH 原生 Workspace/Session 导航重复。

### API_MISSING
- Knowledge 文档上传:`POST /api/knowledge-bases/:id/documents` 不存在。
- Knowledge 文档解析/Chunk/Embedding 触发入口不存在(`addChunks` 无调用方)。
- MCP Tool 试调用 API 不存在。
- Runtime 投影查询 API(当前用户已生效 Skill/KB/MCP/Memory)不存在。
- 会话创建(SDK create)API 不存在。

### SERVICE_MISSING
- `sdk-driver` 全方法 `throw new Error('TODO(T2)')` → 无真实 DSH SDK 调用层。
- 无 Knowledge Ingestion Service(解析器/分块器/embedding)。
- 无 Memory Extraction/Injection Service。
- 无 MCP Runtime Projection Service。
- 无 Skill Package Store(不生成真实 `SKILL.md`,只存 name/description)。

### DB_MISSING
- 无(27 张表结构齐全)。**数据库不是瓶颈。**

### RUNTIME_PROJECTION_MISSING(核心)
- Skill:平台 `t_dsh_skills` / `t_dsh_skill_installations` 有数据,但 Runtime 侧**无 `ctx.skills.registerProvider()`**。
- Knowledge:平台 `t_dsh_knowledge_*` 有数据,但 Runtime 侧**无 Knowledge Adapter**。
- MCP:平台 `t_dsh_mcp_*` 有数据,但 Runtime 侧**无 `@deepseek-ai/dsh-mcp-client` 配置生成**。
- Memory:平台 `t_dsh_memory_records` 有数据,但 Runtime 侧**无 Memory Adapter**。

### PLUGIN_NOT_COMPOSED
- 插件**已被组合**:实测 `__DSH_BOOT__` 清单包含 4 个平台插件,client bundle 返回 200。
- 但:
  - `packages/skill-plaza/host.js`、`packages/knowledge-base/host.js`、`packages/connector/host.js` **全为空实现**(仅 `export const name` + 空 `apply`)。
  - `packages/dsh-bridge/src/host.ts` 使用**猜测 API** `ctx.tools?.guard(...)`,未经官方契约验证。
  - client 插件只注册 `sidebar.footer.action`(侧栏底部小按钮 + 自绘 modal),不是全局面板。

### AUTH_MISSING
- 无(认证/CSRF/租户隔离在平台侧真实可用)。

### VERSION_INCOMPATIBLE(核心阻塞)
- 实测当前 DSH `0.1.1-rc.2` 的 sidebar slots 仅:
  `sidebar.brand.mark`、`sidebar.brand.name`、`sidebar.footer.action`、`sidebar.settings`、`sidebar.workspaces`。
- **不存在 `sidebar.panellist`,也不存在 `main` slot。**
- 目标架构(Phase 03:左栏能力中心 + 中央 Main Panel 切换)在 0.1.1-rc.2 **无法实现**。
- 0.1.5 系列才引入 `sidebar.panellist` + `main`(见纠偏总纲 §二/§八)。

---

## 2. 为什么"会话"进入第二套 UI(PRODUCT_SHELL_SPLIT)

完整链路追踪:

```
Portal DashboardPage  "开始对话" 卡片
  onClick → window.location.href = dshUrl
           (VITE_DSH_UI_URL ?? 'http://localhost:8080/')
       ↓
浏览器离开 Portal(localhost:5173)
       ↓
访问 localhost:8080/(dsh 专属 authority)
       ↓
Gateway proxy.ts  registerDshUiProxy
  preHandler: sessions.readPrincipal → ensureRuntime → seedUserSessions
  httpProxy 动态上游 → http://127.0.0.1:<runtimePort>
       ↓
DSH Web UI(完全独立的第二套前端)
```

同样,`SessionsPage` 的 `enterSession` 成功后 `window.location.href = result.redirectUrl`,
`redirectUrl = ${config.platform.scheme}://${config.dsh.uiAuthority}/` → 同一个第二套 UI。

**判定:当前产品确实是 `Portal Shell → navigation → DSH Shell` 的 PRODUCT_SHELL_SPLIT。**

根因:
1. Portal 是独立 Vite SPA,与 DSH Web 无任何共享运行时。
2. DSH 0.1.1-rc.2 没有全局面板 slot,平台无法把功能"嵌入" DSH。
3. 因此唯一可行的跳转方式就是整页导航到另一个 authority,必然产生"换了个产品"的观感。

---

## 3. DSH Bridge 是否真正加载(实测)

| 检查项 | 结果 |
|---|---|
| Host 半区被 profile 加载 | ⚠️ 被 `--patch` 引入,但 `skill-plaza`/`knowledge-base`/`connector` host 为空;`dsh-bridge` host 用猜测 API |
| Client 半区进入 `dsh.client` boot graph | ✅ 实测 `__DSH_BOOT__.entries` 含 4 个 `@dsh-platform/*` |
| client bundle 是否构建 | ⚠️ `client.bundle.js` 为**手写**产物,与 `src/client.ts` 不同步(src 是占位) |
| 浏览器是否 materialize | ✅ bundle 返回 200 且格式 `__ModuleLoader__.load({id,factory})` 与官方一致 |
| Slot registration 是否成功 | ⚠️ 使用 `sidebar.footer.action`(0.1.1 存在),但注册的是底部按钮+modal,非全局面板 |

---

## 4. 官方 Inspect

- `cordis_inspect what:"client"` 未执行(需在 DSH 交互环境)。
- 替代证据:直接读取 `__DSH_BOOT__` 清单 + 逐个 client bundle HTTP 200,已能证明 client 组合状态。
- 结论:0.1.1-rc.2 **没有新版全局 panel**,如实记录,**未做任何 DOM hack**。

---

## 5. Profile Composition(实测)

```
var/homes/<tenant>/<user>/
  node_modules/@dsh-platform/
    dsh-bridge/{package.json, dist/host.js, client.bundle.js}
    dsh-skill-plaza/{package.json, host.js, client.bundle.js}
    dsh-knowledge-base/{package.json, host.js, client.bundle.js}
    dsh-connector/{package.json, host.js, client.bundle.js}
  profiles/web/
    platform-patch.yml   ← 4 条 insert
    cordis.yml / cordis.patch.yml / package.json
```

`platform-patch.yml` 内容确认 4 个插件已 insert。
**平台插件确实被组合进 Runtime**,但组合的是"空 host + 底部按钮 client",不构成能力闭环。

---

## 6. API / Runtime 穿透结论

| 层 | 状态 |
|---|---|
| UI 点击是否发请求 | ✅ 是(实测各接口 200) |
| route → service → repository → DB | ✅ 全通 |
| DB 变化 | ✅ 真实写入 |
| Runtime 变化 | ❌ **零变化**(无 provider/adapter/client 投影) |
| Harness 是否获得能力 | ❌ 否 |

---

## Exit Gate 回答

**1. 哪些功能真的工作?**
登录、当前身份、注销、CSRF 守卫、工作区列表/创建/S1 重建、ensureRuntime、空闲回收、dsh UI 反代。均为**平台侧**真实生效。

**2. 哪些只是静态 UI?**
Portal Dashboard 能力卡、"我的工作"统计卡、左栏导航(与 DSH 重复)、Skill/Knowledge/MCP/Memory 的四个 client modal 面板(打开后操作只改平台 DB)。

**3. 哪些 API 是占位?**
`POST /api/sessions/migrate`(501)、`sdk-driver` 全方法(TODO)、凭据注入(TODO)、Knowledge 上传/解析(无 API)、MCP Tool 试调用(无 API)。

**4. 哪些数据库结构存在但没有业务代码?**
`t_dsh_knowledge_chunks`(无写入入口)、`t_dsh_knowledge_document_versions`(无写入)、`t_dsh_knowledge_ingestion_jobs`(无写入)、`t_dsh_skill_versions`(无写入)、`t_dsh_skill_reviews`、`t_dsh_skill_favorites`、`t_dsh_mcp_credentials`(无写入)、`t_dsh_provider_credentials`(无写入)、`t_dsh_sync_cursors`(无写入)。

**5. 哪些 DSH 插件从未真正挂载?**
4 个平台插件**都已被组合**(boot 清单可见)。但 `skill-plaza`/`knowledge-base`/`connector` 的 **host 半区为空**,无任何运行时投影;`dsh-bridge` host 使用猜测 API。因此从"能力"角度:Skill Provider / Knowledge Adapter / MCP Projection / Memory Adapter **全部从未存在**。

**6. 为什么"会话"进入第二套 UI?**
PRODUCT_SHELL_SPLIT:Portal 是独立 SPA,进入会话通过 `window.location.href` 整页跳转到 dsh authority(8080),那里是完全独立的 DSH Web。根因是 0.1.1-rc.2 无全局面板 slot,平台无法内嵌。

**7. 现有 Portal 哪些应该删除/保留?**

| 保留 | 删除/降级 |
|---|---|
| `/login`(登录页) | `DashboardPage`(能力卡/统计卡)→ 隐藏或 legacy |
| 错误页 | `SessionsPage`/`WorkspacesPage`(与 DSH 原生重复)→ legacy |
| (可选)/admin | `SkillsPage`/`KnowledgePage`/`McpPage`/`MemoryPage` → 迁入 DSH 全局面板 |
| 认证回调 | Portal 侧栏导航 → 删除 |

**8. 是否必须升级 DSH 才能实现新的 UI 架构?**
**是,必须升级。** 实测 0.1.1-rc.2 无 `sidebar.panellist` / `main` slot,目标"左栏能力中心 + 中央 Main Panel"在架构上不可能。建议目标 `0.1.5-rc.2`(纠偏总纲 §八),但须先做 Phase 02 的版本迁移审计,不得直接升级。

---

## 附:证据索引

| 证据 | 位置/命令 |
|---|---|
| boot 清单含平台插件 | `GET /`(Host: localhost:8080) → `__DSH_BOOT__.entries` |
| client bundle 200 | `GET /plugins/@dsh-platform/dsh-bridge/client.js` → 200, 2548 bytes |
| 0.1.1 slots | `dsh-client-ui-sidebar/lib/client.js` grep `sidebar.*` |
| host 为空 | `packages/{skill-plaza,knowledge-base,connector}/host.js` |
| 无投影 | 全仓库 grep `registerProvider|ctx.skills|dsh-mcp-client` → 0 命中 |
| 501 | `apps/gateway/src/routes/platform.ts:97` |
| SDK TODO | `packages/sdk-driver/src/index.ts:34-59` |
