# dsh-platform

DeepSeek Harness(dsh)的多租户平台层:**网关/BFF + 每用户一个 dsh 运行时**的编排系统。
登录认证、用户-Agent 绑定、权限隔离、会话同步、配额与审计全部收敛在本仓库;dsh 内核零改动,仅经官方扩展点(profile patch、preset、桥接插件)接入。

设计文档(权威,含完整 DDL 与 API 规范):

- [docs/design/MULTI-TENANT-DEPLOYMENT-PLAN.zh-CN.md](docs/design/MULTI-TENANT-DEPLOYMENT-PLAN.zh-CN.md) — 总方案:架构、进程模型、四层隔离、Supervisor、路线图
- [docs/design/platform-user-binding-design.zh.md](docs/design/platform-user-binding-design.zh.md) — P1 具体化:登录/注销、历史会话、工作区校验与迁移

## 目录结构

```
apps/
  gateway/    Fastify 网关:认证(sid cookie)、反代、Supervisor、MySQL、多租户 API
  portal/     Vite + React 中国移动品牌 SPA:登录页、Dashboard、Memory、导航
packages/
  shared/     跨端共享类型:表实体镜像、DTO、TenantContext、Memory/Skill/Knowledge/MCP 类型
  sdk-driver/ 每用户 dsh 运行时驱动骨架(包装 @deepseek-ai/dsh-sdk-client)
  dsh-bridge/ 注入 dsh 实例的组合层插件对(platform-identity / ui-platform-account)
  skill-plaza/      技能广场 client bundle
  knowledge-base/   知识库 client bundle
  connector/        MCP 连接器 client bundle
db/
  schema.sql  dsh_platform 库全部 27 张 t_dsh_* 表 DDL(幂等,含种子数据)
docs/
  design/             权威设计文档(总方案 + P1 具体化)
  implementation/     分阶段实现记录 + 审计报告
  operations/         运维手册
```

## 前置条件

| 依赖 | 版本 | 用途 |
|---|---|---|
| Node | ≥ 22 | 运行时 |
| pnpm | ≥ 10 | workspace 管理 |
| MySQL | 8.0+ | 租户/用户/绑定/配额/审计(`dsh_platform` 库) |
| Redis | 可选 | 网关浏览器会话(T1 已接入;未配置则降级为进程内存) |
| dsh | `0.1.1-rc.2` | 每用户 Agent 运行时(T1 反代联调;`PLATFORM_DSH_BIN` / `PLATFORM_DSH_NODE_BIN`+`PLATFORM_DSH_CLI_ENTRY` 指定 launcher) |

## 快速开始

```sh
pnpm install                          # 安装依赖
cp .env.example .env                  # 按需修改 MySQL 连接
pnpm db:init                          # 建库建表(会提示输入 MySQL root 密码)
pnpm dev:gateway                      # 网关:http://127.0.0.1:8080
pnpm dev:portal                       # 平台首页:http://127.0.0.1:5173(dev 代理 /api /auth /app 到网关)
```

`GET /api/health` 返回 `{ ok, db }`,可同时验证网关与 MySQL 连通。

已有数据库升级到用量统计版本时执行一次：

```sh
mysql --default-character-set=utf8mb4 -h127.0.0.1 -P3306 -uroot -p < db/migrations/008-usage-events.sql
mysql --default-character-set=utf8mb4 -h127.0.0.1 -P3306 -uroot -p < db/migrations/009-usage-attempts.sql
```

租户管理员登录后进入 DSH 界面，在「我的记忆」下方的「用量统计」查看最近 7/30/90 天的模型调用轮次、实际尝试次数、
Token 趋势以及人员/模型分布；普通用户不显示该入口。数据由每用户 DSH Runtime 插件采集并经短期
Runtime Token 上报；插件不直连平台数据库。

未形成最终消息的失败、重试或中断尝试按 DSH 持久 `assistant/attempt.stream` 中最后一条权威 usage 计入；有消息的调用使用 `assistant/message.usage`，包括已中断消息。没有 usage 的尝试只计次数并显示“用量未知”，不估算 Token。一次调用轮次按用户、会话、turn 去重；旧版明细没有 turn 信息，只能按单条记录近似。历史漏采尝试不会因升级自动补齐，需另行从仍保留的 DSH 会话日志回填。

用量上报采用 `${DSH_HOME}/usage-spool` 本地持久队列：网关返回成功后才移除事件；网络故障、缺少通道配置或服务端故障会记录日志并保留重试（每 15 秒，单次请求 5 秒超时）。网关重启后旧 Runtime 的临时 token 会失效，需重启该 Runtime 换取新 token，待报事件会在启动时补发；400/422 错误事件保留为 `.rejected` 文件供排查，不自动丢弃。

### 开发账号(T1)

种子数据内置开发管理员(**仅本地,生产必须改密或走 OIDC**):

| 邮箱 | 密码 | 角色 |
|---|---|---|
| `admin@local.dev` | `Admin@12345` | `tenant_admin` |

改密:生成 argon2id 哈希后写回 `t_dsh_users.password_hash`:

```sh
pnpm --filter @dsh-platform/gateway hash-password <新密码>
```

登录后浏览器持有 `sid`(HttpOnly)与 `csrf_token`(双提交,非 HttpOnly);所有 `/api/*` 的写请求需带 `x-csrf-token` 头。

### T1 已实现(对齐 platform 设计 §3/§8/§10)

- 登录 `POST /auth/login`(argon2id 校验、限速 + 失败锁定、审计)、`GET /auth/me`、`POST /auth/logout`(302 `/login`)。
- `sid` 服务端会话:默认进程内存(单实例开发),配置 `REDIS_URL` 后切 Redis;cookie `HttpOnly + SameSite=Lax`,`Secure` 由 `COOKIE_SECURE`/`NODE_ENV` 决定。
- 全局 CSRF 双提交守卫(`/api/*` 非 GET/HEAD/OPTIONS);未认证一律 401。
- 每用户 dsh 实例反向代理(HTTP + WebSocket),网关按 Host 路由、动态上游、`Host` 透传(与实例 `--trusted-host` 配对)。

未安装 dsh 时可用 `PLATFORM_DSH_MOCK_UPSTREAM=http://127.0.0.1:3080` 把 dsh UI 固定代理到本地 mock 上游,联调代理链路。

### dsh Web UI 拓扑(重要,与设计文档的差异)

实测安装的 dsh 为 **`0.1.1-rc.2`**(设计文档按 `0.1.2-rc.1` 撰写),其 Web 面与设计假设不同:

1. **无 launch token**:启动行是 `dsh web: http://127.0.0.1:<port>`(无 `?token=`);认证模型是 **Host/Origin 可达性围栏,不是认证**(`dsh-client-connection` README:"The fence is a reachability policy, not authentication")。因此网关不实现 launch-token 交换,只透传 `Host`。
2. **前端使用根绝对路径**(`/assets`、`/plugins`、`/api`),**无法挂在 `/app/*` 子路径下**。故 dsh UI 挂在**专属 authority**的根路径,网关按 `Host` 路由:

```
平台首页  http://localhost:5173        (/api、/auth 归网关)
dsh UI    http://localhost:8080/       根路径整体代理到该用户实例
```

- 实例以 `--trusted-host ${PLATFORM_DSH_UI_AUTHORITY}` 拉起,网关把上游请求的 `Host` 覆写为该 authority(保持浏览器 `Origin`),以通过围栏。
- 开发默认 **同 host 不同端口**:`sid` 为 host-only cookie,跨端口自动共享(无需 `Domain`,也无需 DNS)。生产可用独立主机名(`PLATFORM_DSH_UI_AUTHORITY=dsh.corp.example` + `SESSION_COOKIE_DOMAIN=.<父域>`)。
- 网关的 `/api/*` 鉴权/CSRF 仅在平台 Host 生效;dsh UI 所属 Host 上的 `/api/*` 原样透传给实例。
- 注意:Windows 默认不解析 `*.localhost`;若用 `dsh.localhost` 需自行在 hosts 添加 `127.0.0.1 dsh.localhost`(需管理员)。

> 设计文档 §3.2 的 `/app/*` + launch-token 拓扑基于更新版本的 dsh;接入当前版本需按上述专属 authority 拓扑部署(生产建议 `dsh.corp.example` 反代到网关)。

## 数据库

`db/schema.sql` 与设计文档 §3.1(总方案)与 §7(platform 设计)逐表对应,共 10 张表:

`t_dsh_tenants`、`t_dsh_users`、`t_dsh_workspaces`、`t_dsh_agent_bindings`(已含 platform 设计的 `workspace_id`/`migrated_from` 增量列)、`t_dsh_provider_credentials`、`t_dsh_quotas`、`t_dsh_usage_counters`、`t_dsh_runtimes`、`t_dsh_sync_cursors`、`t_dsh_audit_events`。

脚本幂等(先 DROP 后 CREATE),种子数据:默认租户 `default` + 管理员 `admin@local.dev`。

## 与 dsh 的集成

`packages/sdk-driver` 与 `packages/dsh-bridge` 通过 **peerDependencies** 声明对 `@deepseek-ai/dsh@0.1.2-rc.1`、`@deepseek-ai/dsh-sdk-client@0.1.2-rc.1`、`@deepseek-ai/dsh-sdk-protocol@0.1.2-rc.1`、`@deepseek-ai/cordis` 的依赖(锁版本——dsh 处于 developer preview,承诺破坏性变更)。

> 本机实际安装的 dsh 为 **`0.1.1-rc.2`**;网关按此版本的实际 Web 行为适配(见上文「dsh Web UI 拓扑」)。升级 dsh 时需重新核对启动行与 `/api` 围栏行为。

骨架阶段不安装这些 peer(避免对 npm 发布状态的假设),接入方式二选一:

1. dsh 侧 `pnpm pack` / 私有 registry 发布后,把 peerDependencies 提为 dependencies;
2. 本地联调:`pnpm add @deepseek-ai/dsh-sdk-client@0.1.2-rc.1 --filter @dsh-platform/sdk-driver`。

## 路线图(当前实现状态)

| 里程碑 | 内容 | 状态 |
|---|---|---|
| T0 骨架 | 仓库结构、DDL 落库、网关/门户可启动 | ✅ |
| T1 | 登录/注销/sid/CSRF、dsh UI 反代(按 Host 路由) | ✅ |
| T2 | Supervisor:ensureRuntime/空闲回收/心跳/env 注入 | ✅ |
| T3 | dsh-bridge 插件对(whoami、cwd 根校验、tool guard) | ✅ |
| T4 | 平台首页 SPA:会话/工作区/迁移 | ✅ |
| Phase 01 | 项目基线、Harness 兼容性审计 | ✅ |
| Phase 02 | 多租户认证、TenantContext、Repository 层 | ✅ |
| Phase 03 | Memory 隔离、长期记忆、团队治理 | ✅ |
| Phase 04 | Skill 广场、搜索、创建、发布 | ✅ |
| Phase 05 | 知识库、文档导入、RAG | ✅ |
| Phase 06 | MCP 服务中心、Registry、授权 | ✅ |
| Phase 07 | 中国移动品牌 Portal、Design Tokens | ✅ |
| Phase 08 | 安全测试、越权矩阵、E2E 验收 | ✅ |
| Phase 09 | 集成收口、升级策略、最终报告 | ✅ |

### 当前已实现能力

- **认证**:sid cookie + CSRF 双提交 + 登录防爆破(Argon2id)
- **运行时编排**:ensureRuntime/空闲回收/心跳/tenant 隔离路径
- **工作区**:创建/列表/巡检/重建(S1)
- **Memory**:个人私有 + 团队共享 + 显式 Promote + 来源追溯
- **Skill 广场**:Private/Tenant/Public 可见性 + 版本管理 + 安装/卸载
- **知识库**:个人/租户知识库 + 文档管理 + 块级搜索 + 挂载
- **MCP 服务中心**:HTTP + stdio MCP + 审批门禁 + 授权管理
- **审计**:全量审计事件 + AuditRepository
- **门户**:中国移动品牌双栏登录 + Dashboard + 角色感知导航

- **T2**:`supervisor.ts` 维护运行时注册表,`ensureRuntime` 复用/拉起实例;空闲巡检(`PLATFORM_DSH_IDLE_TTL_MS`,默认 30min)优雅排空回收;`t_dsh_runtimes` 落库(starting/ready/draining/dead);子进程 env 剔除平台变量并注入 `PLATFORM_USER_ID`/`PLATFORM_USER_DISPLAY`/`PLATFORM_GATEWAY_ORIGIN`/`PLATFORM_WORKSPACE_ROOT`。凭据解密注入(BYOK)待 P2。
- **T3**:`dsh-bridge` 给出 Cordis 插件形状(`name`/`inject`/`apply`)与可测纯逻辑:`readIdentity`、`isWithinRoot`、`toolGuardDecision`(单调拒绝)、`performLogout`(带 CSRF)。精确的 Typert Remote 与 ui-slots 接线需 `@deepseek-ai/dsh` / `cordis`(peerDependency,当前未安装)。
- **T4**:网关 `/api/workspaces`(含存在性巡检)、`/api/workspaces`(创建)、`/api/sessions`、`/api/sessions/enter`(存在→进入;缺失→弹窗)、`/api/workspaces/recreate`(S1,限用户根内);门户首页渲染工作区/会话、进入检查与缺失弹窗。S2 `/api/sessions/migrate` 依赖 dsh SDK 会话创建,当前返回 501。

## 安全基线(实现时不可违反)

- MySQL 凭据只经 `.env`/环境注入,不进版本库;LLM key 信封加密存 `t_dsh_provider_credentials`,仅进程 env 注入,日志不落明文。
- 越权资源访问返回 404(不返回 403,防探测);`/api/*` POST 全部要求 CSRF 双提交 token。
- dsh 实例只监听 loopback,网络暴露归网关/nginx;launch token 不出网关内存。
