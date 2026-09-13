# 多用户平台设计:登录、用户-Agent 绑定与工作区校验

> 本文是 [MULTI-TENANT-DEPLOYMENT-PLAN.zh-CN.md](../MULTI-TENANT-DEPLOYMENT-PLAN.zh-CN.md)(总方案)中 P1 阶段的具体化设计,覆盖三条用户流程:①平台登录与注销;②历史会话/历史工作区的浏览与进入;③进入历史会话时的工作区存在性校验与迁移。核心目标:**用户信息与 Agent(会话)的绑定**,支撑服务部署后的多人使用场景。
>
> 文中引用的机制均标注代码出处;类型与槽位名称以当前 v0.1.2-rc.1 为准(dev preview,无兼容承诺)。

---

## 1. 需求与用户流程

### 1.1 流程描述

**流程 A:登录与注销**

```
访问平台地址 ──▶ 登录页(默认)──▶ 认证通过 ──▶ 平台首页(历史会话/工作区)
                                              │
                              进入 dsh 页面 ◀──┘
                              └─ 页面右下角设置区域显示账号名
                                 └─ 点击账号名 → 弹出「注销」选项 → 返回登录页
```

**流程 B:历史会话与历史工作区**

登录后可见该用户(且仅该用户)的历史会话列表与历史工作区分组;点击历史会话进入续聊。

**流程 C:工作区存在性校验**

进入历史会话前,先判断该会话绑定的工作区目录在当前服务器上是否存在;不存在则弹窗提示「当前工作区不存在,请选择/创建新的工作区」,用户选择后续路径后才进入。

### 1.2 验收标准

1. 未登录访问任何平台路径一律落到登录页;登录态由网关 cookie 唯一决定。
2. 用户 A 在任何界面都看不到用户 B 的会话与工作区(越权访问返回 404)。
3. dsh 页面设置区域展示当前账号名;点击后可注销;注销后 dsh 页面不可再操作。
4. 历史会话列表跨重启、跨设备可用(数据来自共享卷上的持久化存储,而非进程内存)。
5. 工作区缺失时:进入被拦截并弹窗;用户完成「原路径重建」或「选择新工作区」后才能进入;两条路径都会话历史不丢失。
6. 同一账号多设备并发使用,同一会话不出现双写冲突(单写者所有权约束)。

---

## 2. 总体架构

复用总方案的"网关 + 每用户一个 dsh 实例"模型,本文聚焦的组件如下:

```
浏览器
  │ https://dsh.corp.example/
  ▼
┌─────────────────── Gateway/BFF(自研,Node.js)───────────────────┐
│  /login /auth/*        登录页与认证(OIDC 或本地账号)             │
│  /                     平台首页 SPA:历史会话/工作区/工作区校验弹窗  │
│  /api/sessions|workspaces  会话与工作区查询、进入前检查、迁移      │
│  /app/*                反向代理到该用户实例(HTTP + WS)            │
│  Supervisor            ensureRuntime(user)、launch-token 代理交换 │
└──────────┬──────────────────────────────────────────────────────┘
           │ stdio / loopback + --trusted-host
           ▼
   dsh web 实例(每用户一个)
   $DSH_HOME=/srv/dsh/homes/<user>      ← 会话历史、凭据、设置(共享卷)
   workspace=/srv/dsh/workspaces/<user>/<ws>   ← Agent 的文件操作区
   组合层注入:platform-bridge 插件(Host)+ ui-platform-account(Client)
```

**职责边界**(核心决策,与总方案一致):

- **身份与授权只存在于网关**。dsh 进程无用户概念,也不解析客户端 IP;网关 cookie → 用户 → 该用户唯一实例,授权在用户粒度完成,不需要逐会话鉴权。
- **会话与工作区的"历史数据"分两处**:会话历史(对话事件日志)在 `$DSH_HOME` 的 JSONL 持久化里;工作区只是会话创建时固定的 `cwd`(工具落盘与 `AGENTS.md` 指令加载的根)。**工作区目录丢失不影响对话历史**,只影响文件操作——这是流程 C 设计的基石。
- **网关的 `t_dsh_agent_bindings` 登记表不在请求路径上**,服务审计、迁移谱系与多设备续接;进入实例后的会话列表由产品原生侧栏直接读持久化(冷列表不激活 Agent,`packages/api/session-controller/README.md`)。

---

## 3. 登录与身份设计

### 3.1 认证方式

- 首选 OIDC 对接公司身份源(授权码 + PKCE);无 IdP 时网关自建账号密码(密码哈希 argon2id)+ 可选 TOTP。与总方案 §4 相同,不重复。
- 登录成功后签发**网关会话 cookie** `sid`(HttpOnly、`Secure`、`SameSite=Lax`——Lax 是为了不阻断 OIDC 回跳与平台内部跳转;纯本地账号形态可收紧为 Strict),服务端会话存 Redis(`sid → {userId, deviceId, issuedAt, lastSeen}`),登录时旋转 sid 防固定。
- 平台自身的状态变更接口(`/api/*` 的 POST)使用双提交 CSRF token。

### 3.2 路由与实例 launch-token 代理交换

dsh 实例的浏览器认证是**每进程一枚随机 launch token**:`GET /?token=...` 换取绑定 authority 的签名 cookie(30 天),此后 RPC/WS 都凭 cookie(`packages/client/connection/README.md` "Browser authentication and request trust" 节)。网关代理形态下的完整交换流程:

1. Supervisor 拉起实例时解析 stdout 的 `dsh web: http://127.0.0.1:PORT/?token=...` 行,把 `{port, token}` 存入 runtime 注册表(token 每次进程启动重铸;实例签名 cookie 的密钥持久在 `$DSH_HOME/.credentials.yaml`,实例重启后已登录浏览器不受影响)。
2. 浏览器请求 `GET /app/`,网关以 `Host: dsh.corp.example` 原样透传(与实例启动参数 `--trusted-host dsh.corp.example` 配对,否则 Host/Origin 围栏 403,见总方案附录)。
3. 实例对未认证的 `/` 返回 401;网关捕获后**以自己持有的 token 重放** `GET /app/?token=<token>`,实例 Set-Cookie 经代理透传给浏览器(cookie 绑定的 authority 即平台域名,后续请求自然携带)。
4. 已持有有效实例 cookie 的浏览器不再触发交换。

这样用户永远不需要看见 token URL;令牌分发的安全性收敛为"网关进程内存 + runtime 注册表"。

### 3.3 注销

- 网关 `POST /auth/logout`:删除 Redis 会话、清 `sid` cookie、302 到 `/login`;挂断该浏览器经网关的 WS 连接。
- **实例侧不强制登出**:实例的浏览器 cookie 留存无害(绑定平台 authority,离了网关不可达);如需彻底吊销,Supervisor 删除该 home 的 browser-session 凭据记录并重启实例(产品提供的唯一吊销路径,`packages/client/connection/README.md` Known Limitations:无 logout 操作)。
- 注销时**运行中的轮次默认继续**(用户重新登录后可回到结果);可按租户配置 `logoutPolicy: 'keep' | 'drain'`,`drain` 时 Supervisor 等待 `whenIdle` 后回收实例。

---

## 4. 账号名显示与注销入口(dsh 页面内)

用户要求账号名出现在 **dsh 页面右下角设置区域**(设置外壳占用 `sidebar.settings` 槽位,见 `packages/client/ui-settings/README.md`),点击弹出注销选项。这需要向实例组合注入一个自研插件对(经 profile patch 挂载,即总方案的 `platform-bridge` bundle):

### 4.1 Host 半区:`platform-identity` 插件

- Supervisor 拉起实例时注入 env:`PLATFORM_USER_ID`、`PLATFORM_USER_DISPLAY`(账号显示名)、`PLATFORM_GATEWAY_ORIGIN`(网关地址)。
- 插件暴露一个 Typert Remote:`platform.whoami(): { userId, displayName }`(值来自 env,进程内只读)。按 Typert 约定标注 `@Remote`,经 `api-remotes` 组装后客户端以 `ctx.remote.platform.whoami()` 调用。

### 4.2 Client 半区:`ui-platform-account` 插件

- 经 `ui-slots` 在设置入口旁注册一个账号条目槽位贡献(与 `settings.trigger` 同区域);渲染 `whoami()` 返回的 `displayName`。
- 点击弹出的浮层含「注销」动作:调用网关 `POST /auth/logout`(带 CSRF token)成功后 `location.href = '/login'`。
- **文案走 locale 字典**:新增词条(`platform.account.logout` 等)进类型化词典,经 `t` 渲染——仓库门禁 `verify-client-ui-i18n` 拒绝硬编码文案(根 AGENTS.md "Client UI copy is locale-owned")。
- 显示名由 React 文本渲染,天然防注入;不展示 userId(避免内部标识外泄)。

### 4.3 注销与实例状态的一致性

注销后若浏览器停留在 dsh 页面:WS 被网关挂断,客户端按产品重连语义自动重试;重连请求经网关时因 `sid` 失效被 302 到登录页(网关对 `/app/*` 的未认证响应统一 302,不透传 401,避免客户端把会话失效当作网络错误无限重试)。

---

## 5. 历史会话与历史工作区

### 5.1 两个展示层,一个数据源

| 层 | 位置 | 内容 |
|---|---|---|
| **平台首页**(网关 SPA,登录后落地页) | `/` | 该用户的历史工作区分组 + 各组历史会话;「新建会话」入口;进入前的检查与迁移都发生在这一层 |
| **产品侧栏**(实例内原生 UI) | `/app/...` | 同一份数据的产品化呈现:工作区分组的会话行、增删改排序、搜索、fork、归档(`packages/client/ui-workspace/README.md`) |

两层读到的是同一份持久化(共享卷上的 `$DSH_HOME`),不引入第二真源。平台首页的数据路径:

```
GET /api/sessions → 网关查 t_dsh_agent_bindings(登记表)
                  → 对活跃实例补一次 SDK 会话列表(reconcile 差异:新建/更名/归档)
                  → 返回 [{sessionId, title, workspaceId, updatedAt, status}]
```

- reconcile 是**懒同步**(访问时 + 每 60 s),`t_dsh_agent_bindings` 不是授权路径(§2),允许短暂滞后。
- 工作区 = 会话 `cwd` 的规范化分组(产品同款语义:"Distinct canonical paths remain separate id-keyed Workspaces")。
- 进入实例后,用户主要生活在产品侧栏里;平台首页承担"带检查的门厅"职责。

### 5.2 多设备与单写者

- 同账号多设备经网关路由到**同一实例**;会话事件经产品 follow 流(`opening snapshot + 无 gap 帧`)天然多端同步。
- 写路径(发消息/排队/取消)全部经该实例串行化,不触发 `SessionAlreadyOwnedError`;**禁止**任何绕过网关直连实例的拓扑(实例仅监听 loopback)。

---

## 6. 工作区存在性校验与迁移(流程 C)

### 6.1 支撑事实

1. `SessionCreateRequest` 含 `cwd?`(`packages/api/session-controller/src/types.ts:255`),`SessionForkRequest` 只有 `{ sessionId, atSeq? }`(:291)——**会话的 cwd 在创建时固定,fork 不能改 cwd**。
2. 会话历史在 `$DSH_HOME` 的 JSONL 日志里,与工作区目录无关;工作区丢失=文件操作失效,≠历史丢失。
3. 工作区路径若在用户合法根(如 `/srv/dsh/workspaces/<user>/`)下,重建目录是无损操作。

### 6.2 校验点与拦截时机

```
平台首页点击历史会话
  ▼
POST /api/sessions/enter { sessionId }
  ▼
网关:查绑定 → 取 workspace 路径 → fs.stat(共享卷/或将由 Supervisor 在目标节点执行)
  ├─ 存在 → { ok: true } → ensureRuntime + 打开会话(§6.4)进入续聊
  └─ 不存在 → { ok: false, reason: 'workspace-missing', workspace } → 前端弹窗
```

弹窗(平台 SPA 自有,不走产品 UI):提示「当前工作区不存在,请选择/创建新的工作区」,提供三个动作:

| 动作 | 语义 | 后端 |
|---|---|---|
| **原路径重建**(默认推荐) | 在原路径 `mkdir -p`(仅当路径位于该用户合法根内) | `POST /api/workspaces/recreate { sessionId }` |
| **选择已有工作区** | 从该用户工作区列表选一个 | `POST /api/sessions/migrate { sessionId, mode: 'continue', targetWorkspaceId }` |
| **创建新工作区** | 在用户根下新建目录 | `POST /api/workspaces { name }` 后同上 |

进入实例后的**二次防线**:bridge 插件注册的单调 tool guard 在执行前校验会话 cwd 仍存在,缺失时以明确 reason 拒绝工具执行(防"进入后目录被删"的窗口期),提示用户回平台首页处理。

### 6.3 两条迁移路径的设计

**S1 原路径重建**(会话身份不变)

- 网关在原路径重建空目录 → 直接 resume 原会话。对话历史完整;工作区内此前的文件不可恢复(目录已丢失),UI 文案需明示这一点。
- 约束:仅当原路径位于用户合法根内才允许(否则任何路径都能被网关创建,越权面扩大)。

**S2 新工作区延续**(会话身份变更,谱系保留)

由于 cwd 不可变且 fork 不接受 cwd(§6.1),"换工作区续聊同一会话"在 SDK 面上等价于**在新工作区创建新会话并显式续接上下文**:

```
POST /api/sessions/migrate { sessionId, mode: 'continue', targetWorkspaceId }
  1. 网关读取源会话尾部上下文(经 SDK page/history,取最近 N 轮摘要或末轮 assistant 消息)
  2. SDK create(cwd=新工作区) → 新 sessionId
  3. SDK prompt(新会话,首条消息 = 网关署名的续接说明:
     「本会话延续自会话 <title>(<oldId>),前情摘要:…;原工作区 <path> 已不存在,
       文件请以当前工作区为准。」)
  4. 更新绑定:新会话记录 migrated_from = oldId;旧会话标记 archived(平台首页归档区可读)
```

- 续接说明是普通 `user/message`(带来源),满足"模型可见 ⟺ 已记录"不变式;不伪造历史。
- **P2 增强(产品内路线)**:进程内存在 `CreateAgentOptions.seed`(`SessionEvent[]` 平衡前缀种子,fork-in-process 子代理后端即用此机制)。若在 bridge 插件里加一个 `platform.migrate` Host Remote,用 `ctx.sessions.prepare({ seed })` 以**完整事件级种子**在新 cwd 重建会话,可做到无损迁移;这是插件层扩展,不改内核,留待 P1 验证 SDK 面不够后再做。

### 6.4 进入会话的落位

- 网关 `ensureRuntime(user)`(实例存活则复用)→ SDK `resume(sessionId)`(若实例刚拉起)→ 302 到 `/app/`。
- 目标会话的打开由 `ui-platform-account` 同 bundle 的 client 插件完成:网关在 302 目标 URL 上带一次性 handoff 参数(`?pick=<token>`,Redis 60 s 有效),client 插件启动时兑换并经客户端会话 API 打开对应会话。产品的 SPA 路由是否原生支持会话深链是 **P1 验证项**;handoff 机制不依赖它。

### 6.5 目录选择器的组合修正

产品的"添加文件夹"经目录选择流填充(`ui-workspace` 的 directory-flow 洞),选择器有 native/browse 两个后端;`directory-picker-auto` 在**回环绑定 + 有显示平台**时选 native——那会在服务器上弹原生对话框,对远程浏览器用户完全错误。部署组合必须**显式组合 `ui-directory-picker-browse`**(浏览器内浏览服务器目录)填充该洞。已知边界(开放问题 §11):browse 选择器当前无根目录限定配置,会暴露服务器目录树——缓解 = 每实例以独立 OS 用户运行,Linux 权限天然遮挡他人目录;工作区路径合法性在 create 时由 bridge 插件校验(拒绝用户根之外的 cwd)。

---

## 7. 数据模型(相对总方案的增量)

```sql
-- 约定同总方案 §3.1:MySQL 8.0+、InnoDB、utf8mb4、应用层 UUID、DATETIME(3) 存 UTC。

-- 工作区登记(平台首页分组、存在性巡检、迁移谱系的载体)
-- canonical_path 取 VARCHAR(512):与 user_id 组成唯一键后仍在 InnoDB
-- 3072 字节索引上限内((36+512)×4 = 2192);超长路径需改用规范化哈希入键。
CREATE TABLE t_dsh_workspaces (
  id             CHAR(36)      PRIMARY KEY,
  user_id        CHAR(36)      NOT NULL,
  canonical_path VARCHAR(512)  NOT NULL,    -- 规范化绝对路径
  display_name   VARCHAR(128)  NOT NULL,
  last_used_at   DATETIME(3),
  archived_at    DATETIME(3),
  missing_since  DATETIME(3),               -- 巡检发现缺失的时间,NULL=在
  UNIQUE KEY uk_workspaces_user_path (user_id, canonical_path),
  CONSTRAINT fk_workspaces_user FOREIGN KEY (user_id) REFERENCES t_dsh_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 绑定表增列(总方案 t_dsh_agent_bindings 之上;MySQL 忽略列内 REFERENCES,外键表级声明)
ALTER TABLE t_dsh_agent_bindings
  ADD COLUMN workspace_id  CHAR(36),
  ADD COLUMN migrated_from VARCHAR(128),   -- S2 迁移的源会话 id
  ADD KEY idx_bindings_workspace (workspace_id),
  ADD CONSTRAINT fk_bindings_workspace FOREIGN KEY (workspace_id) REFERENCES t_dsh_workspaces(id);

-- 网关浏览器会话(Redis 为主,结构示意)
platform_session(sid HASH): { user_id, device_id, issued_at, last_seen,
                              csrf_secret, revocation_epoch }
```

审计事件(`t_dsh_audit_events`)新增动作:`login`、`logout`、`session.enter`、`workspace.missing`(含路径)、`workspace.recreate`、`session.migrate`。

---

## 8. 网关 API 规范

| 方法与路径 | 鉴权 | 语义 |
|---|---|---|
| `GET /login` | 公开 | 登录页 |
| `POST /auth/login` | 公开(限速) | 账号密码登录;成功 Set-Cookie `sid` 并旋转 |
| `GET /auth/oidc/*` | 公开 | OIDC 授权码流(启用时) |
| `GET /auth/me` | `sid` | `{ userId, displayName }` |
| `POST /auth/logout` | `sid` + CSRF | 注销(§3.3) |
| `GET /api/workspaces` | `sid` | 用户工作区列表(含 `exists` 巡检值) |
| `POST /api/workspaces` | `sid` + CSRF | 在用户根下创建新工作区目录 |
| `GET /api/sessions` | `sid` | 历史会话列表(reconcile 后) |
| `POST /api/sessions/enter` | `sid` + CSRF | 进入前检查:存在→`{ok}`;缺失→`{ok:false, reason:'workspace-missing'}` |
| `POST /api/workspaces/recreate` | `sid` + CSRF | S1:原路径重建(限用户根内) |
| `POST /api/sessions/migrate` | `sid` + CSRF | S2:新工作区延续(§6.3) |
| `GET /app/*`(含 WS 升级) | `sid` | 反向代理到该用户实例;未认证 302 `/login`;代理 launch-token 交换(§3.2) |

错误约定:资源不存在或非本人资源一律 `404`(不返回 403,防探测);校验失败 `400` 带机器可读 code。

---

## 9. 关键时序

**登录 → 进入历史会话(工作区存在)**

```
浏览器          网关                    实例(用户U)      共享卷/Redis
  │ GET /            │                       │                │
  │◄─ 302 /login     │                       │                │
  │ POST auth/login ─▶ 校验 ──────────────────────────────────▶ sid 写入
  │◄─ 302 /          │                       │                │
  │ GET /            │                       │                │
  │◄─ 平台首页(会话/工作区列表,bindings+reconcile)             │
  │ POST sessions/enter ─▶ fs.stat(workspace) ── ok            │
  │◄─ 302 /app/?pick=token │                 │                │
  │ GET /app/ ──────▶ ensureRuntime ─spawn──▶ │                │
  │                  │ 401 ← GET /           │                │
  │                  │ GET /?token=… ───────▶│ Set-Cookie     │
  │◄─ 200 + Set-Cookie(透传)+ 页面          │                │
  │ WS /app(客户端插件兑换 pick → 打开会话,follow 流)          │
```

**工作区缺失 → S1/S2**

```
  │ POST sessions/enter ─▶ fs.stat 失败 ─▶ {ok:false, workspace-missing}
  │◄─ 弹窗「当前工作区不存在,请选择/创建新的工作区」
  │ [原路径重建] POST workspaces/recreate ─▶ mkdir -p(根内校验)─▶ {ok}
  │    └─ 继续 enter 流程(resume 原会话;历史完整,工作区文件为空)
  │ [选择/新建工作区] POST sessions/migrate ─▶ 读源会话尾部 ─▶ create(新cwd)
  │    ─▶ prompt(续接说明) ─▶ 绑定 migrated_from ─▶ {ok, newSessionId}
  │    └─ enter 新会话
```

**注销**

```
  │(dsh 页面,点击账号名 → 浮层 → 注销)
  │ POST /auth/logout + CSRF ─▶ 删 Redis 会话、挂断 WS ─▶ 302 /login
  │   实例按 logoutPolicy: keep(轮次继续)/ drain(whenIdle 后回收)
```

---

## 10. 安全清单

| 项 | 措施 |
|---|---|
| 会话 cookie | HttpOnly + Secure + SameSite=Lax;登录旋转;Redis 可吊销 |
| CSRF | 双提交 token 覆盖全部 `/api/*` POST |
| 登录防爆破 | 网关限速 + 失败锁定 + 审计 |
| 越权 | 资源访问先验归属,失败 404;`/app/*` 只代理到本人实例 |
| 实例暴露面 | 仅 loopback 监听;`--trusted-host` 只声明平台 authority;launch token 不出网关内存 |
| 目录浏览泄漏 | 每实例独立 OS 用户;browse 选择器暴露面见 §6.5 开放问题 |
| 工作区越界 | create 时 bridge 插件校验 cwd 位于用户根;S1 重建同样限根内 |
| 传输 | 平台入口 TLS(nginx/网关终结);实例流量不出本机 |
| 凭据 | `DEEPSEEK_API_KEY` 仅 env 注入;日志与审计不落明文 |
| 审计 | 登录/注销/进入/迁移/工作区缺失全量入 `t_dsh_audit_events` |

---

## 11. 开放问题(P1 验证项)

1. **产品 SPA 会话深链**:URL 是否原生支持定位会话;若支持,handoff 机制可简化为 302 直链。
2. **browse 目录选择器的根限定**:当前无配置面;若上游增加 rooting 配置则收敛目录暴露面,否则依赖 OS 用户隔离。
3. **会话中途工作区被删**:tool guard 拒绝后的 UI 引导(拉回平台首页处理)需要 client 插件配合提示。
4. **S2 摘要质量**:续接说明的上下文量(N 轮 vs 全量摘要)对体验的影响,需实测;`platform.migrate` seed 路线(§6.3 P2)是彻底解。
5. **多节点部署**:"当前电脑"语义在 Supervisor 多主机时的落位——检查与 ensureRuntime 必须落在同一节点(总方案 §8 的按主机分组)。

---

## 12. 实施计划

| 任务 | 内容 | 依赖 | 预估 |
|---|---|---|---|
| T1 | 网关骨架:登录/注销/`sid`/CSRF + `/app/*` 代理 + launch-token 交换 | 总方案 P0 完成 | 1 周 |
| T2 | Supervisor:ensureRuntime/空闲回收/env 注入/`--trusted-host` | T1 | 1 周(与 T1 并行) |
| T3 | platform-bridge Host 插件(`whoami`、cwd 根校验、tool guard)+ ui-platform-account Client 插件(账号条目/注销浮层/i18n 词条) | T2 | 1–1.5 周 |
| T4 | 平台首页 SPA:会话/工作区列表、reconcile、enter 检查、缺失弹窗、S1/S2 | T1/T2 | 1.5 周 |
| T5 | 测试:e2e 三流程 + 越权矩阵 + 双设备并发 + 实例崩溃恢复 + 注销策略两档 | 全部 | 1 周 |

合计约 5–6 周(2 后端 + 1 前端),落在总方案 P1 窗口内。测试基线沿用总方案:越权用例必须包含"构造他人 sessionId/工作区 id 直接打 `/api/*`"的负路径;双设备用例必须覆盖同一会话的 follow 同步与排队一致性。
