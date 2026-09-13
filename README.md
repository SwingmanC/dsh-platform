# dsh-platform

DeepSeek Harness(dsh)的多租户平台层:**网关/BFF + 每用户一个 dsh 运行时**的编排系统。
登录认证、用户-Agent 绑定、权限隔离、会话同步、配额与审计全部收敛在本仓库;dsh 内核零改动,仅经官方扩展点(profile patch、preset、桥接插件)接入。

设计文档(权威,含完整 DDL 与 API 规范):

- [docs/design/MULTI-TENANT-DEPLOYMENT-PLAN.zh-CN.md](docs/design/MULTI-TENANT-DEPLOYMENT-PLAN.zh-CN.md) — 总方案:架构、进程模型、四层隔离、Supervisor、路线图
- [docs/design/platform-user-binding-design.zh.md](docs/design/platform-user-binding-design.zh.md) — P1 具体化:登录/注销、历史会话、工作区校验与迁移

## 目录结构

```
apps/
  gateway/    Fastify 网关:认证(sid cookie)、/app/* 反代、Supervisor、MySQL 访问
  portal/     Vite + React 平台首页 SPA:登录页、历史会话/工作区、迁移弹窗
packages/
  shared/     跨端共享类型:表实体镜像与 DTO
  sdk-driver/ 每用户 dsh 运行时驱动(包装 @deepseek-ai/dsh-sdk-client)
  dsh-bridge/ 注入 dsh 实例的组合层插件对(platform-identity / ui-platform-account)
db/
  schema.sql  dsh_platform 库全部 t_dsh_* 表 DDL(幂等,含种子数据)
```

## 前置条件

| 依赖 | 版本 | 用途 |
|---|---|---|
| Node | ≥ 22 | 运行时 |
| pnpm | ≥ 10 | workspace 管理 |
| MySQL | 8.0+ | 租户/用户/绑定/配额/审计(`dsh_platform` 库) |
| Redis | 可选 | 网关浏览器会话(T1 接入;骨架阶段未用) |

## 快速开始

```sh
pnpm install                          # 安装依赖
cp .env.example .env                  # 按需修改 MySQL 连接
pnpm db:init                          # 建库建表(会提示输入 MySQL root 密码)
pnpm dev:gateway                      # 网关:http://127.0.0.1:8080
pnpm dev:portal                       # 平台首页:http://127.0.0.1:5173(dev 代理 /api /auth /app 到网关)
```

`GET /api/health` 返回 `{ ok, db }`,可同时验证网关与 MySQL 连通。

## 数据库

`db/schema.sql` 与设计文档 §3.1(总方案)与 §7(platform 设计)逐表对应,共 10 张表:

`t_dsh_tenants`、`t_dsh_users`、`t_dsh_workspaces`、`t_dsh_agent_bindings`(已含 platform 设计的 `workspace_id`/`migrated_from` 增量列)、`t_dsh_provider_credentials`、`t_dsh_quotas`、`t_dsh_usage_counters`、`t_dsh_runtimes`、`t_dsh_sync_cursors`、`t_dsh_audit_events`。

脚本幂等(先 DROP 后 CREATE),种子数据:默认租户 `default` + 管理员 `admin@local.dev`。

## 与 dsh 的集成

`packages/sdk-driver` 与 `packages/dsh-bridge` 通过 **peerDependencies** 声明对 `@deepseek-ai/dsh@0.1.2-rc.1`、`@deepseek-ai/dsh-sdk-client@0.1.2-rc.1`、`@deepseek-ai/dsh-sdk-protocol@0.1.2-rc.1`、`@deepseek-ai/cordis` 的依赖(锁版本——dsh 处于 developer preview,承诺破坏性变更)。

骨架阶段不安装这些 peer(避免对 npm 发布状态的假设),接入方式二选一:

1. dsh 侧 `pnpm pack` / 私有 registry 发布后,把 peerDependencies 提为 dependencies;
2. 本地联调:`pnpm add @deepseek-ai/dsh-sdk-client@0.1.2-rc.1 --filter @dsh-platform/sdk-driver`。

## 路线图(对齐设计文档)

| 里程碑 | 内容 | 状态 |
|---|---|---|
| T0 骨架 | 仓库结构、DDL 落库、网关/门户可启动 | ✅ 本仓库 |
| T1 | 登录/注销/sid/CSRF、`/app/*` 代理、launch-token 交换 | 骨架占位 |
| T2 | Supervisor:ensureRuntime/空闲回收/env 注入/`--trusted-host` | `supervisor.ts` 占位 |
| T3 | dsh-bridge 插件对(whoami、cwd 根校验、tool guard) | `dsh-bridge` 占位 |
| T4 | 平台首页 SPA:会话/工作区列表、enter 检查、S1/S2 迁移 | `portal` 占位 |
| T5 | e2e 三流程 + 越权矩阵 + 双设备并发 | 未开始 |

## 安全基线(实现时不可违反)

- MySQL 凭据只经 `.env`/环境注入,不进版本库;LLM key 信封加密存 `t_dsh_provider_credentials`,仅进程 env 注入,日志不落明文。
- 越权资源访问返回 404(不返回 403,防探测);`/api/*` POST 全部要求 CSRF 双提交 token。
- dsh 实例只监听 loopback,网络暴露归网关/nginx;launch token 不出网关内存。
