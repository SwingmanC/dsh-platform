# REWORK-01 — Feature Wiring Matrix

> 审计日期:2026-09-16
> 方法:阅读当前源码 + 实机启动 Gateway/Portal/MySQL/DSH Runtime + HTTP/清单穿透
> 状态枚举:WORKING | PARTIAL | SHELL_ONLY | BROKEN | NOT_IMPLEMENTED

---

## 结论速览

| 分类 | 数量 |
|---|---|
| WORKING(端到端真实生效) | 4 |
| PARTIAL(部分链路缺失) | 4 |
| SHELL_ONLY(UI/DB 存在但 Runtime 不生效) | 5 |
| NOT_IMPLEMENTED | 5 |

**核心结论:平台侧 CRUD 与数据库是真实的,但 Skill/Knowledge/MCP/Memory 四类能力在 DSH Runtime 侧没有任何投影(投影实现为零)。因此这四类全部是 SHELL_ONLY。**

---

## 1. 认证与身份

| Feature | UI Component | API | Service | DB/Storage | DSH Integration | Real Mutation | Status |
|---|---|---|---|---|---|---|---|
| 登录 | `LoginView` (main.tsx) | `POST /auth/login` | `routes/auth.ts` | `t_dsh_users` + SessionStore | N/A | ✅ 写审计 + 建会话 | **WORKING** |
| 当前身份 | `App` useEffect | `GET /auth/me` | `routes/auth.ts` | SessionStore | N/A | 只读 | **WORKING** |
| 注销 | `Topbar` 退出 | `POST /auth/logout` | `routes/auth.ts` | SessionStore | N/A | ✅ 删会话 | **WORKING** |
| CSRF 守卫 | 全局 preHandler | — | `index.ts` + `session.ts` | SessionStore | N/A | ✅ 拒绝无 token 写请求 | **WORKING** |
| 身份注入 Runtime | — | — | `supervisor.childEnv` | env 注入 `PLATFORM_USER_ID` | host plugin `platform-identity` | ⚠️ 插件读取 env,但 host 用**猜测 API** `ctx.tools.guard`,未验证 | **PARTIAL** |

## 2. 工作区 / 会话

| Feature | UI Component | API | Service | DB/Storage | DSH Integration | Real Mutation | Status |
|---|---|---|---|---|---|---|---|
| 工作区列表 | `WorkspacesPage` | `GET /api/workspaces` | `workspaceRepository` | `t_dsh_workspaces` | N/A | 只读 + 存在性巡检 | **WORKING** |
| 创建工作区 | `WorkspacesPage` | `POST /api/workspaces` | `routes/platform.ts` | `t_dsh_workspaces` + fs mkdir | N/A(不在 DSH 会话 cwd 中体现) | ✅ 建目录 + 登记 | **WORKING** |
| 会话列表 | `SessionsPage` | `GET /api/sessions` | `agentBindingRepository` | `t_dsh_agent_bindings` | N/A | 只读 | **PARTIAL** |
| 进入会话 | `SessionsPage` | `POST /api/sessions/enter` | `routes/platform.ts` | 读 binding | 302 到 DSH UI | ⚠️ 只校验工作区存在后跳转,不真正打开指定会话 | **PARTIAL** |
| S1 原路径重建 | `SessionsPage` 弹窗 | `POST /api/workspaces/recreate` | `routes/platform.ts` | fs mkdir | N/A | ✅ 建目录 | **WORKING** |
| S2 迁移 | — | `POST /api/sessions/migrate` | `routes/platform.ts:97` | — | 需 SDK | ❌ 硬编码 `501 not-implemented` | **NOT_IMPLEMENTED** |
| 会话创建(Runtime 侧) | — | — | `sdk-driver` | — | — | ❌ 全部方法 `throw TODO(T2)` | **NOT_IMPLEMENTED** |
| 会话列表同步 | — | — | `session-sync.ts` | 读 binding | 尽力调 dsh RPC | ⚠️ best-effort,失败静默吞掉 | **PARTIAL** |

## 3. Runtime 编排

| Feature | UI Component | API | Service | DB/Storage | DSH Integration | Real Mutation | Status |
|---|---|---|---|---|---|---|---|
| ensureRuntime | 代理 preHandler | `POST /api/runtimes/ensure` | `supervisor.ts` | `t_dsh_runtimes` + 子进程 | spawn `dsh web` | ✅ 实测可拉起 | **WORKING** |
| 空闲回收 | — | — | `startIdleReaper` | `t_dsh_runtimes` | kill 子进程 | ✅ | **WORKING** |
| 凭据注入 | — | — | `supervisor.ts:94` | `t_dsh_provider_credentials` | env `DEEPSEEK_API_KEY` | ❌ `TODO(T2 凭据)`,未实现 | **NOT_IMPLEMENTED** |
| dsh UI 反代 | — | `/` on dsh authority | `proxy.ts` | — | HTTP+WS 反代 | ✅ 实测 200 | **WORKING** |

## 4. Skill

| Feature | UI Component | API | Service | DB/Storage | DSH Integration | Real Mutation | Status |
|---|---|---|---|---|---|---|---|
| 技能搜索 | `SkillsPage` | `GET /api/skills` | `skill-service` | `t_dsh_skills` | ❌ 无 `ctx.skills.registerProvider` | 只写/读平台 DB | **SHELL_ONLY** |
| 安装/卸载 | `SkillsPage` | `POST/DELETE /api/skills/:id/install` | `skill-repository` | `t_dsh_skill_installations` | ❌ Runtime 不知情 | DB 变,`ctx.skills` 不变 | **SHELL_ONLY** |
| 发布 | `SkillsPage` | `POST /api/skills/:id/publish` | `skill-repository` | `t_dsh_skills.status` | ❌ | DB 变 | **SHELL_ONLY** |
| 创建 | `SkillsPage` | `POST /api/skills` | `skill-service` | `t_dsh_skills` | ❌ 不生成真实 `SKILL.md` | DB 只存 name/description | **SHELL_ONLY** |
| skill-plaza 插件 | `sidebar.footer.action` 按钮 + modal | 复用 `/api/skills` | `host.js` 为空 | 同 DB | ❌ host 无 provider | 打开 modal,无 Runtime 效果 | **SHELL_ONLY** |
| Agent 实际使用 Skill | — | — | — | — | ❌ | — | **NOT_IMPLEMENTED** |

## 5. Knowledge

| Feature | UI Component | API | Service | DB/Storage | DSH Integration | Real Mutation | Status |
|---|---|---|---|---|---|---|---|
| 知识库列表/创建 | `KnowledgePage` | `GET/POST /api/knowledge-bases` | `knowledge-service` | `t_dsh_knowledge_bases` | ❌ 无 adapter | DB 变 | **SHELL_ONLY** |
| 挂载 | `KnowledgePage` | `POST /api/knowledge-bases/:id/mount` | `knowledge-repository` | `t_dsh_knowledge_mounts` | ❌ Agent 不知情 | DB 变 | **SHELL_ONLY** |
| 文档上传 | — | ❌ 无上传 API | — | — | — | — | **NOT_IMPLEMENTED** |
| 解析/Chunk/Embedding | — | — | `addChunks` 存在但无调用方 | `t_dsh_knowledge_chunks` | — | 无入口触发 | **NOT_IMPLEMENTED** |
| 块检索 | — | `GET /api/knowledge/search` | `searchChunks` | `t_dsh_knowledge_chunks` | ❌ | 表恒空 → 恒返回 0 | **SHELL_ONLY** |
| Agent RAG 检索 | — | — | — | — | ❌ | — | **NOT_IMPLEMENTED** |
| knowledge-base 插件 | `sidebar.footer.action` + modal | 复用 API | `host.js` 为空 | 同 DB | ❌ | 打开 modal | **SHELL_ONLY** |

## 6. MCP

| Feature | UI Component | API | Service | DB/Storage | DSH Integration | Real Mutation | Status |
|---|---|---|---|---|---|---|---|
| 服务列表/创建 | `McpPage` | `GET/POST /api/connectors` | `mcp-service` | `t_dsh_mcp_connectors` | ❌ 无 `dsh-mcp-client` 投影 | DB 变 | **SHELL_ONLY** |
| 授权/审批 | `McpPage` | `POST /api/connectors/:id/authorize` | `mcp-repository` | `t_dsh_mcp_authorizations` | ❌ | DB 变 | **SHELL_ONLY** |
| Runtime 投影 | — | — | — | — | ❌ 未生成 cordis MCP 配置 | — | **NOT_IMPLEMENTED** |
| Tool 出现在 Agent | — | — | — | — | ❌ | — | **NOT_IMPLEMENTED** |
| Tool 试调用 | — | ❌ 无 API | — | — | — | — | **NOT_IMPLEMENTED** |
| connector 插件 | `sidebar.footer.action` + modal | 复用 API | `host.js` 为空 | 同 DB | ❌ | 打开 modal | **SHELL_ONLY** |

## 7. Memory

| Feature | UI Component | API | Service | DB/Storage | DSH Integration | Real Mutation | Status |
|---|---|---|---|---|---|---|---|
| 创建/搜索/删除 | `MemoryPage` | `GET/POST/DELETE /api/memory` | `memory-service` | `t_dsh_memory_records` | ❌ 无 memory adapter | DB 变 | **SHELL_ONLY** |
| 提升为团队 | `MemoryPage` | `POST /api/memory/:id/promote` | `memory-service` | `t_dsh_memory_records.visibility` | ❌ | DB 变 | **SHELL_ONLY** |
| 跨 Session 召回 | — | — | — | — | ❌ | — | **NOT_IMPLEMENTED** |
| 自动提取 | — | — | — | — | ❌ | — | **NOT_IMPLEMENTED** |

## 8. 产品壳

| Feature | UI Component | API | Service | DB/Storage | DSH Integration | Real Mutation | Status |
|---|---|---|---|---|---|---|---|
| 独立 Portal Dashboard | `DashboardPage` | 多个 | — | — | ❌ 与 DSH 是两套壳 | 独立于 DSH | **SHELL_ONLY** |
| 能力卡入口 | `DashboardPage` | `window.location.href` | — | — | ❌ 跳出到 DSH 或死链 | — | **SHELL_ONLY** |
| 左栏能力中心 | — | — | — | — | ❌ 需 `sidebar.panellist`(0.1.5) | — | **NOT_IMPLEMENTED** |
| 全局 Main Panel | — | — | — | — | ❌ 需 `main` slot(0.1.5) | — | **NOT_IMPLEMENTED** |

---

## 状态统计(逐条)

- **WORKING(4)**:登录、当前身份、注销、CSRF 守卫(+工作区列表/创建/S1/ensureRuntime/反代)
- **PARTIAL(4)**:身份注入 Runtime、会话列表、进入会话、会话同步
- **SHELL_ONLY(5)**:Skill 全套、Knowledge 列表/挂载/检索、MCP 全套、Memory 全套、独立 Portal 壳
- **NOT_IMPLEMENTED(5)**:S2 迁移、SDK Driver、凭据注入、Knowledge 上传/解析、MCP 投影/试调用、Memory 召回、全局面板

---

## 说明:为什么 WORKING 项也没有形成"产品闭环"

工作区/会话/认证在**平台侧**是真实的,但:

1. DSH Runtime 与平台 Portal 是两个独立壳(见 `REWORK-01-shell-gap-report.md`)。
2. 平台创建的 Workspace 只是文件系统目录 + DB 登记,DSH 侧栏读的是 `$DSH_HOME` 持久化,两者未做 reconcile。
3. 因此即使 WORKING 项,用户体验上仍是"平台操作"与"DSH 操作"两套。
