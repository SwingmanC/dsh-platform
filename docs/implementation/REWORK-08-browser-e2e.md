# REWORK-08 — Browser E2E (真实 Chrome/Edge)

> 日期:2026-09-18
> 浏览器:Microsoft Edge(Playwright `channel: msedge`,headless)
> Node:`v24.11.0`(nvm) · DSH:`0.1.5-rc.2` · Gateway:真实 MySQL + 真实 Redis
> 自动化:`scripts/final-e2e/*.mjs`

---

## 环境

| 项 | 值 |
|----|----|
| Browser | Edge(系统安装,Playwright 1.63 驱动) |
| Platform authority | `localhost:5173`(Vite dev portal,代理 `/api`,`/auth` → Gateway) |
| DSH UI authority | `localhost:8080`(Gateway 按 Host 反代到 per-user dsh) |
| Node | `v24.11.0`(launcher preflight PASS) |
| Redis | `redis://127.0.0.1:6379`(Gateway `session=redis`,无 memory fallback) |
| MySQL | 运行,所有 migration 已应用 |

---

## B1 — 未登录

- `GET http://localhost:5173/` → portal 登录页(邮箱/密码表单)。
- 未认证访问 dsh authority `http://localhost:8080/` → Gateway 代理 preHandler 302 到 `http://localhost:5173/login`。
- URL 不含 DSH launch token。

**结果:PASS**

## B2 — 登录 + 主壳

真实填写 `admin@local.dev` / 密码 → 登录成功(portal Dashboard 出现「开始对话」)→ 进入 `http://localhost:8080/`。

DSH Web Shell 观测到:

```text
移 · 中国移动 · 数智智能体平台
新会话 · 技能广场 · 知识中心 · MCP 服务 · 我的记忆
工作区 · 平台管理员 · 退出 · 设置
```

- **无 iframe**;无 Portal Dashboard 作为普通用户主壳;无第二套 SPA 主导航。
- Boot 图含 `@dsh-platform/dsh-bridge/client.js` 与 `@dsh-platform/cmcc-platform-ui/client.js`。

**结果:PASS**

## B3 — 四 Panel 导航

依次点击 sidebar 能力入口,验证 **main keyed panel 切换**(无整页跳转,url 恒为 `http://localhost:8080/`):

| Panel | main 内容标记 | 结果 |
|-------|---------------|------|
| 技能广场 | 「新建技能」 | PASS |
| 知识中心 | 「新建知识库」 | PASS |
| MCP 服务 | 「新建连接器」 | PASS |
| 我的记忆 | 「平台记忆库」 | PASS |

- 无 React crash / 白屏;`/api/*` 请求 0 失败(无 4xx/5xx)。
- Console 仅登录前 `/auth/me` 401(预期)与 favicon 404(无害)。

**结果:PASS**

## B4 — Session → Panel → Session

- 点击「新会话」返回 Conversation(URL 不变,DSH 原生会话面)。
- 当前部署下**未创建会话**(见下)。

---

## B5 — REAL_BROWSER_REFRESH_E2E

```text
REAL_BROWSER_REFRESH_E2E = NOT_EXECUTED
```

### 阻塞根因(真实发现)

进入 DSH Shell 后,会话面显示:

```text
探索未至之境 · 选择一个工作区开始
```

- 平台未为普通用户预置任何 DSH workspace(`t_dsh_workspaces` 为空)。
- 平台 `platform-identity` 插件只读取 identity env,**不注册/同步 workspace**。
- `packages/sdk-driver` 为 `DEFERRED_WITHOUT_PRODUCTION_PATH` 桩(所有方法 `throw TODO`),**无程序化 workspace/session 驱动路径**。
- DSH 原生 workspace picker 的「添加工作区」调用 **native 目录选择器**
  (`@deepseek-ai/dsh-client-ui-directory-picker-native`),在 Web Shell 中无法弹出/完成
  (点击后停留「添加工作区…」,无 browse 回退)。

因此**普通用户无法在浏览器中创建/选择工作区 → 无法发起对话 → 无法产生 assistant streaming → 无法执行 refresh 测试**。

这不是自动化脚本缺陷,而是产品级 gap:**workspace provisioning / conversation start 未闭环**。

**结果:BLOCKED(REAL_BROWSER_REFRESH_E2E 无法执行)**

## B6 — Runtime restart(browser)

- Runtime restart 本身在 Phase 06/07 已通过 HTTP 级验证(spawn/drain/投影恢复)。
- 浏览器保持打开时的 restart recovery 依赖活动会话,而会话无法创建 → **NOT_EXECUTED(随 B5 阻塞)**。

## B7 — Logout / Login

- Portal `POST /auth/logout`(CSRF)→ 平台 session 失效;再次访问受保护资源 302 → `/login`。
- 平台 sid 为 HttpOnly;`dsh-auth-*` 为 HttpOnly + SameSite=Strict。退出后即便浏览器仍持有旧 `dsh-auth-*`,平台代理 preHandler 因**平台 session 失效**仍 302 → `/login`(不绕过 Platform Auth)。

**结果:PASS(HTTP + 代理层验证)**

## B8 — A/B 双用户

- 通过独立 Browser Context 登录 A/B,验证不同 `sid`、不同 Runtime(独立 `runtimeId`/port/process/DSH_HOME)。
- 会话级 A/B 浏览器隔离依赖活动会话 → **NOT_EXECUTED(随 B5 阻塞)**;API/投影级隔离见 `REWORK-08-security-e2e.md`。

---

## 结论

| 项 | 结果 |
|----|------|
| B1 未登录 | PASS |
| B2 登录 + 主壳 + 品牌 + 四入口 | PASS |
| B3 四 Panel 导航 | PASS |
| B4 Session→Panel→Session | 部分(返回会话 OK;无法创建会话) |
| B5 REAL_BROWSER_REFRESH_E2E | **NOT_EXECUTED(BLOCKED: 无法开始对话)** |
| B6 浏览器 Runtime restart | NOT_EXECUTED(同上) |
| B7 Logout/Login | PASS |
| B8 A/B 浏览器 | 部分(NOT_EXECUTED 会话级) |

**长期 blocker(REAL_BROWSER_REFRESH_E2E)已定位为可复现的产品 gap,而非“无浏览器”问题。**