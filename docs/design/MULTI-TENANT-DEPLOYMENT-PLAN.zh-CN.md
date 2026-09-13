# DeepSeek Harness 多租户多用户部署技术实现方案

> 目标:将 dsh 部署到公司服务器,面向多租户(multi-tenant)、多用户(multi-user)提供 Agent 服务,覆盖租户管理、用户管理、登录认证、Agent 与用户绑定、权限隔离、会话上下文同步。
>
> 本方案基于仓库 v0.1.2-rc.1 的真实能力(`docs/architecture.zh.md`、`packages/sdk/`、`packages/api/session-controller/`、`docs/subsystems/persistence.zh.md` 等)制定;引用的机制均注明出处。

---

## 0. 现状评估:必须先说清的三个事实

制定方案前,先明确 dsh 当前形态对多用户部署的约束:

**事实 1:dsh 是"单用户、本地优先"的产品,没有任何内置的租户/用户/登录概念。**

- 随附 `web` profile 是为一个本地浏览器用户设计的:默认绑定 `127.0.0.1:3080`,且 `dsh web` **刻意拒绝 `--host 0.0.0.0`**(`docs/subsystems/web-server.zh.md`)。Connection 插件对每个 Host API 路由做 Host/Origin 校验和"浏览器会话认证"——这个信任模型假定"连进来的浏览器就是机主"。
- 仓库中没有 user/tenant/authn 实体;`SessionId` 是品牌化的进程内标识,不含外部用户语义。

**事实 2:项目的正确扩展方式是插件与组合,而不是改造内核。**

- 官方约定:"Plugins, not loop changes"——新行为挂在已文档化的扩展点上(根 `AGENTS.md`)。把 dsh 内部改造成多用户服务,等于逆着它的设计方向施工,且下一条事实会让这条路很贵。

**事实 3:developer preview,承诺破坏性变更。**

- 官方 README 明示 "THERE WILL BE COMPATIBILITY-BREAKING CHANGES";`SESSION_FORMAT_VERSION` 保持 `0` 且无兼容承诺(根 `AGENTS.md` pre-release 条款)。任何深度绑定内部结构的改造,都会在每次 upstream 升级时重付代价。

**由此得出本方案的核心决策:**

> **不在 dsh 进程内实现多租户,而是在其外新建一个"多租户网关层"(Gateway/BFF),把每个 dsh 实例当作"每用户一个的 Agent 运行时"来编排。** dsh 以官方支持的 `--profile sdk`(stdio JSON-RPC,见 `packages/sdk/README.md`,Python SDK 正是以此方式驱动完整运行时)作为被驱动面,多用户、认证、隔离、同步全部收敛到网关层。dsh 侧仅通过**官方扩展点**(profile patch、preset、一个自研桥接插件)做少量配置型接入。

部署操作系统选 **Linux**:进程沙箱的 Linux 后端(bwrap/Landlock)可报告 `full` 完整强制执行;Windows ACL 后端仅 `partial`(Everyone/硬链接边界缺口,`docs/subsystems/sandbox.zh.md`),不适合作为多租户信任边界。

---

## 1. 总体架构

```
                          ┌────────────────────────────────────────────────┐
                          │                公司服务器(Linux)                │
                          │                                                │
 用户浏览器/客户端         │  ┌──────────────┐   ┌──────────────────────┐   │
 ────HTTPS/WSS──────────┼─▶│  nginx/Traefik │──▶│  Gateway / BFF(自研)  │   │
                          │  │  (TLS 终结)   │   │  · 认证/JWT 校验      │   │
                          │  └──────────────┘   │  · 租户/用户/配额/ACL  │   │
                          │                     │  · 会话路由表          │   │
                          │                     │  · WS 扇出/游标续传     │   │
                          │                     │  · 审计与用量采集       │   │
                          │                     └──────┬───────────────┘   │
                          │                            │ stdio JSON-RPC     │
                          │                            │ (每用户一进程)      │
                          │              ┌─────────────┼─────────────┐     │
                          │              ▼             ▼             ▼     │
                          │        ┌──────────┐ ┌──────────┐  ┌──────────┐ │
                          │        │ dsh sdk  │ │ dsh sdk  │  │ dsh sdk  │ │
                          │        │ 用户 A    │ │ 用户 B   │  │ 用户 C    │ │
                          │        │ home_A/  │ │ home_B/  │  │ home_C/  │ │
                          │        │ ws_A/    │ │ ws_B/    │  │ ws_C/    │ │
                          │        └────┬─────┘ └────┬─────┘  └────┬─────┘ │
                          │             │            │             │       │
                          │      ┌──────┴────────────┴─────────────┴────┐ │
                          │      │ MySQL(租户/用户/映射/配额/审计)       │ │
                          │      │ Redis(路由表/在线状态/限流)           │ │
                          │      │ 共享卷(各用户 home 与 workspace)      │ │
                          │      │ Keycloak/Casdoor(OIDC,可选)          │ │
                          │      └───────────────────────────────────────┘ │
                          └────────────────────────────────────────────────┘
```

组件职责:

| 组件 | 职责 | 来源 |
|---|---|---|
| 接入层 | TLS、限速、WS 升级 | nginx/Traefik |
| **Gateway/BFF(自研)** | 登录认证、租户/用户管理、Agent-用户绑定、权限隔离、会话同步扇出、配额、审计、运行时编排 | **新建**(本方案主体) |
| dsh runtime 池 | 每用户一个 `dsh --profile sdk` 进程,独立 `$DSH_HOME`、独立 workspace、独立 env 凭据 | 现成(SDK profile) |
| Supervisor | runtime 进程生命周期(冷启动/空闲回收/崩溃恢复/升级排空),可并入 Gateway | 新建 |
| 桥接插件(可选) | dsh 侧审批回调、租户工具 guard、遥测转发 | 新建(小,Cordis 插件,走官方扩展点) |
| 数据层 | MySQL 8/Redis/共享卷/IdP | 现成基础设施 |

---

## 2. 进程模型选型(本方案最关键的决策)

| 方案 | 形态 | 隔离强度 | 资源成本 | 适用 |
|---|---|---|---|---|
| **A1(推荐)** | 每用户一个 dsh 进程(进程内多会话) | 强:进程 + 独立 home + 独立 env + 独立 workspace | 每进程约 150–300 MB,靠空闲回收控制 | 内外部租户混合,默认选择 |
| A2 | 会话粘性进程池(一个进程服务某用户的部分会话) | 中:同用户会话可共进程,跨用户仍隔离 | 密度更高,路由更复杂 | 用户量大、并发会话多时的优化档 |
| B | 单个 dsh 进程多路复用所有用户 | 弱:凭据共享(进程级 env)、同进程文件系统、同一 OS 用户 | 最低 | **仅**高信任内部场景,不建议作为起点 |

**决定选 A1 的两个硬约束(均来自代码库事实):**

1. **会话单写者所有权**:持久化层规定每个会话 id 同时只能有一个活跃写句柄,第二次 `open(id, 'write')` 抛 `SessionAlreadyOwnedError`(`docs/subsystems/persistence.zh.md`)。因此**路由必须粘性**:同一会话的写请求必须落到持有其写句柄的进程。A1 天然满足(用户的所有会话都在其唯一进程里);A2 需要会话→进程的显式路由表;B 无此问题但隔离不足。
2. **凭据是进程级 env**:`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` 从环境或 home `.env` 读取(根 `AGENTS.md` Secrets 节)。要做到"每租户自己的 key"或"平台 key 但按租户记账",必须在**进程边界**注入——只有 A1/A2 做得到干净注入。

**规模预估**:500 活跃用户 × 250 MB ≈ 125 GB 内存(峰值同时在线的子集)。若超出,横向加主机(Supervisor 按主机分组),或对重度内部用户降级到 A2。

---

## 3. 租户管理与用户管理

全部实现在 Gateway + MySQL,dsh 不感知。

### 3.1 数据模型(核心表)

```sql
-- 约定:MySQL 8.0+,InnoDB,utf8mb4;表名统一 t_dsh_ 前缀;主键 CHAR(36) 为应用层生成的 UUID
--      (可用 UUIDv7 改善索引局部性);时间列 DATETIME(3) 由应用层统一写 UTC
--      (避开 TIMESTAMP 类型的 2038 上限);MySQL 会解析但忽略列内 REFERENCES,
--      外键一律写成表级 FOREIGN KEY 子句。

-- 租户
CREATE TABLE t_dsh_tenants (
  id            CHAR(36)      PRIMARY KEY,
  slug          VARCHAR(64)   NOT NULL,        -- URL 标识
  name          VARCHAR(128)  NOT NULL,
  plan          VARCHAR(32)   NOT NULL DEFAULT 'standard',
  settings      JSON          NOT NULL,        -- 模型白名单、工具白名单、审批策略、沙箱模式
  created_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_tenants_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 用户(归属单一租户;SSO 场景用 external_sub 关联)
CREATE TABLE t_dsh_users (
  id            CHAR(36)      PRIMARY KEY,
  tenant_id     CHAR(36)      NOT NULL,
  external_sub  VARCHAR(128),                  -- OIDC subject,普通索引
  email         VARCHAR(254)  NOT NULL,
  display_name  VARCHAR(128)  NOT NULL,
  role          VARCHAR(32)   NOT NULL DEFAULT 'member',  -- 'tenant_admin' | 'operator' | 'member'
  status        VARCHAR(16)   NOT NULL DEFAULT 'active',  -- active | disabled
  created_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_users_tenant_email (tenant_id, email),
  KEY idx_users_external_sub (external_sub),
  CONSTRAINT fk_users_tenant FOREIGN KEY (tenant_id) REFERENCES t_dsh_tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 租户级 LLM 凭据(信封加密存储)
CREATE TABLE t_dsh_provider_credentials (
  tenant_id     CHAR(36)      NOT NULL,
  provider      VARCHAR(32)   NOT NULL,        -- 'deepseek' | ...
  ciphertext    VARBINARY(2048) NOT NULL,      -- KMS/信封加密后的 key
  rotated_at    DATETIME(3)   NOT NULL,
  PRIMARY KEY (tenant_id, provider),
  CONSTRAINT fk_credentials_tenant FOREIGN KEY (tenant_id) REFERENCES t_dsh_tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 配额与用量
CREATE TABLE t_dsh_quotas (
  tenant_id     CHAR(36)      NOT NULL,
  kind          VARCHAR(64)   NOT NULL,        -- 'concurrent_runtimes' | 'sessions' | 'daily_tokens'
  limit_val     BIGINT        NOT NULL,
  PRIMARY KEY (tenant_id, kind),
  CONSTRAINT fk_quotas_tenant FOREIGN KEY (tenant_id) REFERENCES t_dsh_tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE t_dsh_usage_counters (
  tenant_id     CHAR(36)      NOT NULL,
  day           DATE          NOT NULL,
  tokens_in     BIGINT        NOT NULL DEFAULT 0,
  tokens_out    BIGINT        NOT NULL DEFAULT 0,
  requests      BIGINT        NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ★ Agent↔用户绑定(dsh SessionId 与外部身份的映射,权威在网关)
CREATE TABLE t_dsh_agent_bindings (
  session_id    VARCHAR(128)  PRIMARY KEY,     -- dsh SessionId(品牌化字符串,序列化同 string;MySQL 的 TEXT 不能做主键)
  tenant_id     CHAR(36)      NOT NULL,
  user_id       CHAR(36)      NOT NULL,
  runtime_id    CHAR(36),                      -- 当前持有写句柄的 runtime 进程
  title         VARCHAR(512),
  workspace     VARCHAR(1024) NOT NULL,        -- 该会话的 cwd(绝对路径)
  status        VARCHAR(16)   NOT NULL DEFAULT 'active',
  created_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_bindings_user_recent (user_id, updated_at DESC),
  KEY idx_bindings_tenant_user (tenant_id, user_id),
  CONSTRAINT fk_bindings_tenant FOREIGN KEY (tenant_id) REFERENCES t_dsh_tenants(id),
  CONSTRAINT fk_bindings_user FOREIGN KEY (user_id) REFERENCES t_dsh_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- runtime 进程注册表(也可只放 Redis,落库便于审计)
CREATE TABLE t_dsh_runtimes (
  id             CHAR(36)      PRIMARY KEY,
  user_id        CHAR(36)      NOT NULL,
  host           VARCHAR(255)  NOT NULL,
  dsh_version    VARCHAR(32)   NOT NULL,       -- 钉住的 dsh 版本
  state          VARCHAR(16)   NOT NULL,       -- starting | ready | draining | dead
  last_heartbeat DATETIME(3)   NOT NULL,
  pid            INT,
  CONSTRAINT fk_runtimes_user FOREIGN KEY (user_id) REFERENCES t_dsh_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 多设备同步游标 & 审计
CREATE TABLE t_dsh_sync_cursors (
  session_id    VARCHAR(128)  NOT NULL,
  device_id     VARCHAR(64)   NOT NULL,
  last_seq      BIGINT        NOT NULL,
  PRIMARY KEY (session_id, device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE t_dsh_audit_events (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id  CHAR(36),
  actor      CHAR(36),
  action     VARCHAR(64)   NOT NULL,
  subject    VARCHAR(256),
  payload    JSON,
  at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_audit_tenant_time (tenant_id, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

> 为什么映射放网关而不塞进 dsh:`SessionHeader.meta` 的形状是固定的(cwd、fork 谱系、`isSeeded`、来源分类、委派深度、agentPreset,见 `docs/subsystems/core.zh.md`),不是任意 KV。外部身份属于部署层概念,权威数据放 MySQL,dsh 保持干净。

### 3.2 管理 API(网关 REST,草案)

```
POST   /admin/tenants                    创建租户(同时初始化 preset 集/配额/凭据槽)
PATCH  /admin/tenants/:id                更新设置(模型白名单、工具白名单、审批策略)
GET    /admin/tenants/:id/users          用户列表
POST   /admin/tenants/:id/users          创建/邀请用户
PATCH  /admin/users/:id                  启停、改角色
PUT    /admin/tenants/:id/credentials    换 LLM key
GET    /admin/tenants/:id/usage          用量报表
```

`tenant_admin` 角色可自助管理本租户;平台管理员(`/admin/tenants`)属于运营方。

---

## 4. 登录与认证

### 4.1 推荐主路径:OIDC 对接公司身份源

- 公司已有 IdP(AD/LDAP、钉钉、企业微信、飞书)→ 前置 Keycloak 或 Casdoor 做协议桥,Gateway 作为 OIDC RP。
- 授权码模式 + PKCE;`external_sub` 落库建唯一索引;JIT 开户(首次登录按邮箱域映射租户)或管理端预建。
- 无公司 IdP 时:Casdoor/Keycloak 直接当用户名密码 + TOTP 的用户库用,不自己发明认证。

### 4.2 令牌策略

- **Access JWT**(15 min,含 `tenant_id`/`user_id`/`role`,RS256 签名,网关本地验签)+ **Refresh Token**(旋转,Redis 记录吊销)。
- **WebSocket 认证**:WS 升级请求带短时一次性 ticket(先 REST 换取),避免把长寿命 token 放 URL;升级后首帧再校验一次并绑定连接身份。
- **网关 → dsh runtime:不做应用层认证**。runtime 以 `--profile sdk` 跑 stdio,只监听网关的子进程管道,不暴露任何端口;信任边界 = 进程边界 + 网关主机的网络隔离。

### 4.3 明确不做的事

- **绝不**把 dsh 的 webserver 直接暴露到 `0.0.0.0`(产品本身就拒绝了这个姿态);所有入站流量只认网关。
- 网关校验所有会话访问的 `tenant_id`/`user_id` 归属(见 §6 L2),JWT 里的身份是唯一可信来源,不信任客户端传的 session 归属字段。

---

## 5. Agent 与 userId 绑定

### 5.1 生命周期链路

```
用户发首条消息(或点"新建会话")
  │
  ▼
Gateway:鉴权 → 配额检查 → ensureRuntime(user)
  │   ┌─ runtime 存活且心跳正常 → 复用
  │   └─ 否则 Supervisor 拉起:
  │        dsh --profile sdk --home /srv/dsh/homes/<tenant>/<user>
  │        env: DEEPSEEK_API_KEY=<租户key或平台key>  DSH_* ...
  │        stdio ↔ Gateway 子进程管理器;ready 后写 t_dsh_runtimes 表 + Redis 路由
  ▼
Gateway → SDK client: create session(cwd = /srv/dsh/workspaces/<tenant>/<user>/<session>)
  │        (SDK 会话创建支持显式 id;或创建后读回 SessionId)
  ▼
写 t_dsh_agent_bindings(session_id, tenant_id, user_id, runtime_id, workspace)
  ▼
SDK prompt → follow 流订阅 → 扇出给该用户的所有在线设备
```

### 5.2 绑定关系的规则

- **一对一授权**:任何对 `session_id` 的操作(prompt/cancel/follow/page/fork)先查 `t_dsh_agent_bindings`,非本租户本用户(且非授权协作者)一律 404(不返回 403,避免探测)。
- **恢复链路**:用户重连 → 网关查绑定 → 定位 runtime → 若 runtime 已死:`Supervisor` 重新拉起进程并经 SDK `resume(sessionId)` 恢复(dsh 的 resume 会自行计算 `interruptedTurnClosers`,把崩溃遗留的开放轮次以 `interrupted` 原因闭合后继续,见 `docs/subsystems/persistence.zh.md` 崩溃恢复节)。旧进程已死即写句柄已释放,新进程接管不触发 `SessionAlreadyOwnedError`。
- **fork 与谱系**:dsh 的 fork 产生 `parentSession` 谱系;网关在 fork 时同步复制绑定记录并保留 `parent_session_id`,供 UI 呈现"从某轮次分叉"。

---

## 6. 权限隔离(四层防御)

### L1 进程与文件系统隔离(A1 模型的基础)

- 每用户独立 `$DSH_HOME`(profiles、presets、settings、`.env`、会话存储)与独立 workspace 目录;目录权限 `0700`,属主为该 runtime 的 Linux 用户(或同 UID + 依赖 L4 沙箱约束)。
- home 隔离同时带来**凭据隔离**与 **preset 隔离**:租户的工具裁剪、模型路由就是"往各 home 放什么 preset",不需要动 dsh 代码。

### L2 网关 ACL(唯一入站面)

- 所有 session/workspace 资源先鉴权后路由;跨租户/跨用户访问在网关终结。
- 管理面(租户/用户/凭据)按角色(RBAC);`member` 只能看到自己的会话。

### L3 dsh 组合层(官方扩展点,不碰内核)

按租户在 home 里下发受控组合,实现**能力裁剪**:

| 控制目标 | dsh 机制 | 出处 |
|---|---|---|
| 按租户裁剪模型路由 | profile patch 替换/禁用 llm provider 行;网关同时校验模型白名单 | 架构文档"新行为的归属位置" |
| 按租户裁剪工具集 | agent preset(`cordis.yml`,`isolate` realm)+ `ToolRestriction`(allow/deny) | `docs/subsystems/tools.zh.md` |
| 免交互场景的确定性拒绝 | 审批策略 `never`(会话级,持久化为 `approval/policy` 事件) | `docs/subsystems/approval.zh.md` |
| 交互场景的人工审批 | `approval/request` waterfall 应答者 →(自研桥接插件)HTTP 回调网关 → 推送到用户 UI;超时/不可达 = `unavailable` = 拒绝(fail-closed) | 同上 |
| 最终防线 | 自研**单调 tool guard**插件:从 env 读租户策略,对禁用工具名返回拒绝 reason(guard 无 allow 结果,顺序无法翻案) | `docs/subsystems/tools.zh.md` |
| 文件效果边界 | 沙箱模式 `workspace-write`,workspace root = 会话 cwd | `docs/subsystems/sandbox.zh.md` |

桥接插件做成一个私有 bundle(`company-gateway-bridge`),经 profile patch 挂进各 home 的 `sdk` profile——这正是 bundle/patch 机制的设计用途(`docs/architecture.zh.md` Profile 与组合包节)。

### L4 OS 沙箱

- Linux 生产主机启用 `dsh-sandbox-local`(bwrap/Landlock):默认 `workspace-write`,root 锁定为该会话 workspace;只读操作可降 `read-only`。
- **enforcement 检查**:后端报告 `partial`(旧 Landlock ABI 等)时,网关/组合层必须视为不满足隔离承诺——要么拒绝启动该会话,要么明确降级告警。这是文档规定的消费方义务(`docs/subsystems/sandbox.zh.md`)。

### 凭据与密钥

- 两条路线,可并存:**平台 key**(运营方统一 key,网关按 `t_dsh_usage_counters` 记账限流)与 **BYOK**(租户自带 key,KMS 信封加密存 `t_dsh_provider_credentials`,拉起 runtime 时解密注入 env)。
- key 只在 runtime 进程环境内存中存在;会话日志不含凭据;审计事件不记录明文。

---

## 7. 会话上下文同步

dsh 的持久化模型天然利于同步:**会话 = 仅追加的 JSONL 事件日志(唯一真源)**,消息历史、UI、遥测全部从日志派生;`follow` 流的协议形态是"完整 opening snapshot + 无 gap 的增量帧",且明确支持游标续传(`packages/api/session-controller` 的 `follow`/`page` Remote,`docs/subsystems/web-client.zh.md` 重连节)。网关在此之上做多端编排:

### 7.1 在线扇出(多设备同看一个会话)

```
dsh follow(session, cursor) ──▶ Gateway ──┬──▶ 设备 1 的 WS(游标 1200)
                                          ├──▶ 设备 2 的 WS(游标 1180,先 page() 回填再接增量)
                                          └──▶ 更新 t_dsh_sync_cursors
```

- 网关对每会话维持**一条**到 runtime 的 follow 订阅,向 N 个设备扇出;设备各自带 `last_seq` 游标,缺口用 `page()` 回填(该接口就是为更早历史与 gap 修复设计的)。
- 设备断线重连:凭游标续传;runtime 侧无感知。

### 7.2 跨入口接管(同一用户换浏览器/换机器)

- 路由表命中同一 runtime → 直接扇出加入,无迁移成本。
- runtime 已回收/崩溃 → §5.2 的 respawn + resume 链路;`interrupted` 轮次闭合由 dsh 自动完成。

### 7.3 后台运行与通知(可选增强)

- 用户关页后会话不中断:turn 在 runtime 中继续;网关保留 follow 订阅,完成后经 webhook/IM 推送摘要(会话标题、最后一条 assistant 消息)。
- 定时任务类需求可评估 dsh 的 schedule/webhook 能力是否经网关白名单开放。

### 7.4 用量与审计采集

- token 用量:每步的 `assistant/message.usage` 与 `assistant/chunk { type: 'usage' }` 都在日志里;网关从 follow 流提取并累计入 `t_dsh_usage_counters`(计费/配额)。亦可挂 OTel(`session-telemetry-otel`)导出到公司观测栈。
- 审计:登录、会话创建、审批决策(`approval/asked`/`approval/decided`)、管理操作入 `t_dsh_audit_events`;原始 JSONL 定期归档对象存储,`t_dsh_agent_bindings` 提供索引。

---

## 8. Runtime Supervisor 设计

并入 Gateway 或独立守护服务,职责:

1. **拉起**:`ensureRuntime(user)` —— home 目录初始化(下发租户 preset/patch/桥接插件)、env 注入(解密凭据)、spawn `dsh --profile sdk --home ...`、stdio 管道接管、ready 握手(SDK client 的启动即就绪)、注册路由。
2. **心跳与 健康**:runtime 定期心跳;失联标记 `dead`,触发 §5.2 恢复。
3. **空闲回收**:用户全部会话 `whenIdle` 且 TTL(如 30 min)无新请求 → 优雅排空(dsh teardown 自带最终 flush,`session/disposed` 排空句柄,不丢事件)→ 回收进程与路由。
4. **并发控制**:每租户 `concurrent_runtimes`、每用户会话数配额;超限在网关层排队/拒绝。
5. **升级**:钉版本的 dsh 二进制;升级时对新拉起 runtime 用新版本,存量 runtime 标记 `draining`,空闲后自然回收——避免杀掉持有写句柄的进程。
6. **崩溃语义**:进程被 OOM/kill → 写句柄随进程关闭而释放;下次访问 resume 时由 dsh 闭合 `interrupted` 轮次,已持久化事件无损(撕裂的物理尾部由 JSONL 后端丢弃,`docs/subsystems/persistence.zh.md`)。

---

## 9. 部署拓扑与运维

- **形态**:Docker Compose 起步(单机:gateway + mysql(8.0+) + redis + IdP + runtime host);规模上来后 K8s(runtime 以每用户 Pod 或同节点进程池形态,共享卷换 PVC/对象存储)。MySQL 例行逻辑备份(mysqldump)或物理备份(XtraBackup),主从读写分离按需引入。
- **存储**:共享卷按 `/srv/dsh/homes/<tenant>/<user>` 与 `/srv/dsh/workspaces/...` 分层;JSONL 日志与 header 成对备份;归档到对象存储(生命周期策略)。
- **网络**:仅网关暴露 443;runtime 全部 stdio 无端口;MySQL/Redis 走内网。
- **版本钉住**:dev preview 必须锁版本(如 `0.1.2-rc.1`),升级按"新版本先服务新拉起的 runtime → 灰度 → 全量"推进;每次升级前跑 SDK 契约测试(基于 `packages/sdk/protocol` 的类型做 wire 冒烟)+ 关键快照回放。
- **可观测**:网关标准指标 + dsh 侧 OTel 导出;关键告警 = runtime 崩溃率、写句柄冲突错误(`SessionAlreadyOwnedError` 不应出现在网关日志)、配额拒绝率、follow 流断连率。

---

## 10. 实施路线图

| 阶段 | 内容 | 出口标准 | 预估 |
|---|---|---|---|
| **P0 PoC** | 脚本驱动 `dsh --profile sdk`:创建会话、prompt、follow、断线重连游标续传、kill 进程后 resume(验证 `interrupted` 闭合);顺带验证每用户独立 home/env 的启动参数 | 全链路脚本通过;记录 SDK wire 冒烟用例 | 1–2 周 |
| **P1 MVP** | Gateway 骨架(OIDC 登录 + JWT)、用户/会话表、ensureRuntime/空闲回收、会话列表/新建/续聊/取消的基础 UI(自研前端或先接内部工具)、`t_dsh_agent_bindings` ACL | 10 个内部用户日常可用;杀进程会话可恢复 | 3–4 周 |
| **P2 多租户** | 租户 CRUD、RBAC、配额、凭据信封加密与注入、租户 preset/工具裁剪下发、单调 guard 桥接插件、审批回调路由到 UI | 两个试点租户隔离验证通过(含越权测试用例) | 3–4 周 |
| **P3 同步与运营** | 多设备扇出与游标、后台运行通知、用量报表、审计查询、压测(百级并发 runtime 的内存/调度) | 压测指标达标;审计可追溯审批与登录 | 2–3 周 |
| **P4 持续** | 版本升级流程、灾备演练、沙箱 enforcement 巡检 | — | 持续 |

团队假设:2–3 名后端 + 1 名前端,总计约 9–13 周到多租户可用。

---

## 11. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| dsh dev preview 破坏性变更(`SESSION_FORMAT_VERSION=0` 无兼容承诺) | 升级即迁移 | 钉版本;升级走灰度;SDK 契约测试 + 会话快照回放进 CI;存量会话只读兼容评估后再迁移 |
| 误把 web profile 当多用户面 | 信任模型错配(其 Connection 假定单一本地浏览器用户) | 本方案一律走 SDK profile;web UI 复用需先 PoC 其 Host/Origin 与认证的可配置性,不作为依赖 |
| 会话写句柄冲突 | 双写报 `SessionAlreadyOwnedError` | 路由一律经绑定表粘性到持有进程;升级只 drain 不强杀 |
| 每用户进程内存 | 高并发成本 | 空闲回收;必要时对内部高信任用户降级 A2;横向扩主机 |
| LLM key 泄漏面 | 平台/租户凭据风险 | 信封加密、仅 env 注入、日志脱敏、key 轮换与审计 |
| 沙箱 partial enforcement | 隔离承诺打折 | 生产仅 Linux;启动时检查 enforcement 报告,partial 即拒绝或显式降级告警 |
| subagent 的 claude-code/codex 大体积二进制 | 镜像膨胀、外部产品凭据混入 | 多租户组合默认**不安装**这两个 bundle,按租户显式开启 |
| 长会话上下文膨胀 | token 成本与延迟 | 启用 dsh compaction 能力(已是 seam,策略可配);网关按租户设 token 配额 |

---

## 12. 结论

- **要建的**:一个多租户网关(认证/租户/用户/绑定/ACL/同步扇出/配额/审计)+ runtime Supervisor + 一个小的 dsh 桥接插件(审批回调、guard)。
- **不动的**:dsh 内核与其事件模型——SDK profile、JSONL 持久化、follow/page 流、resume/fork、preset 与沙箱,全部以现成能力消费。
- **先证明的**(P0):SDK 驱动全链路 + 崩溃恢复 + home/env 隔离启动,一周内可验证,再投入网关开发。

---

## 附录:轻量内网试点——IP 路由的每用户 web 实例

在网关落地前,可用"客户端 IP 当路由键"的形态先跑起来(≤几十人、高信任内网、固定工位)。

**为什么不能在单个 `dsh web` 实例内按 IP 绑定 Agent**:浏览器信任围栏(`packages/client/connection/src/api-request-trust.ts`)只校验 Host/Origin,明确不承担认证;进程看不到反代后的客户端 IP;`SessionHeader.meta` 无 owner 字段,会话列表对全部连接者可见;每进程一枚 launch token,无每用户身份。单实例共享 = 零隔离。

**可行形态**:每用户一个 `dsh web` 实例(独立 `$DSH_HOME`、独立 loopback 端口),nginx 按 `$remote_addr` 路由。要点:

1. 实例保持 loopback 并声明公网 authority:`dsh web --no-open --port 30xx --trusted-host <公网IP:端口>`(`--trusted-host` 可重复,见 `packages/bundle/web-app/src/startup.ts`)。不要把实例绑 `0.0.0.0`(CLI 刻意拒绝;网络暴露归 nginx)。
2. nginx **原样透传 Host**(`proxy_set_header Host $http_host`)并转发 WebSocket Upgrade——改写 Host 会导致 Origin≠Host,WS 握手全部 403。
3. 首次登录:监督脚本解析实例 stdout 的 `dsh web: http://127.0.0.1:PORT/?token=...` 行,把同枚令牌拼进公网入口 URL 发给该用户;令牌换得的签名 cookie(30 天,绑定 authority)在实例重启后仍有效(签名密钥持久于 `$DSH_HOME/.credentials.yaml`)。
4. 同步边界:同实例内会话续聊/恢复原生可用;IP 即身份,用户换设备/换网络即失联。两个用户共用同一浏览器配置文件访问同一 host:port 会互顶 cookie,按人分端口可规避。

**风险**:DHCP 漂移(需地址固定)、无审计/吊销、令牌 URL 转发即冒充。定位为 P1 前的试点:实例布局(每用户 home/workspace)与网关方案同构,后续只需把"IP→实例"换成"登录态→实例",dsh 侧不返工。
