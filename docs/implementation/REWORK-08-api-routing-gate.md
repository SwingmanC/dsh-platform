# REWORK-08 — API Routing Collision Gate

> 日期:2026-09-18
> 脚本:`scripts/final-e2e/api-routing.mjs`
> 环境:Gateway(node 24.11,真实 MySQL/Redis),`PLATFORM_DSH_UI_AUTHORITY=localhost:8080`,`PLATFORM_AUTHORITY=localhost:5173`

---

## 路由归属

| 层 | Host | 处理 |
|----|------|------|
| 平台 API | 任意 | `isPlatformApiPath(path)` 精确/前缀白名单 → 平台认证 + handler |
| DSH 原生 API | `localhost:8080`(dsh authority) | 非平台路径 → `@fastify/http-proxy` 反代到 per-user dsh |
| Portal | `localhost:5173` | Vite 代理 `/api`,`/auth` → `127.0.0.1:8080` |

`PLATFORM_API_PATTERNS`(prefix)含:`/api/skills`、`/api/knowledge-bases`、`/api/knowledge/*`、`/api/connectors`、`/api/memory`、`/api/sessions`、`/api/workspaces`、`/api/runtimes/ensure` 等。

---

## 实测(带平台认证)

### Platform host `127.0.0.1:8080`

| 请求 | 结果 | 期望 |
|------|------|------|
| `GET /api/skills` | 200 | 平台 ✓ |
| `GET /api/knowledge-bases` | 200 | 平台 ✓ |
| `GET /api/connectors` | 200 | 平台 ✓ |
| `GET /api/memory` | 200 | 平台 ✓ |
| `GET /api/session/list` | 404 | 非平台路由,且代理仅绑 dsh authority → 404 ✓ |
| `GET /api/remote` | 404 | 同上 ✓ |
| `GET /api/unknown-xyz` | 404 | 明确 404 ✓ |

### Platform host 未认证

| 请求 | 结果 |
|------|------|
| `GET /api/skills` | 401 |
| `GET /api/session/list` | 401 |
| `GET /api/unknown-xyz` | 401 |

平台 `/api/*` 在未认证时统一 401(不泄漏路由存在性)。

### DSH authority `localhost:8080`(带平台 cookie,无 dsh-auth cookie)

| 请求 | 结果 | 说明 |
|------|------|------|
| `GET /api/session/list` | 401 | 反代到 dsh;dsh 要求自身浏览器 cookie → 401(预期) |
| `GET /api/unknown-xyz` | 401 | 反代到 dsh → dsh 401 |

---

## 结论

- DSH 原生 `/api/session/*`、`/api/remote` 等**不被平台 prefix 白名单误捕获**(平台侧 404,非 401/403 CSRF 拦截)。
- 平台 `/api/{skills,knowledge,connectors,memory}` 正确命中 Gateway。
- 未知 `/api/<unknown>`:平台 host 明确 401/404;dsh authority 由 dsh 处理。
- Shell 内四 Panel 运行在 `localhost:8080`,调用 `/api/skills` 等:因 `isPlatformApiPath` 命中,走平台认证 → 实测 0 失败。

**API namespace collision gate = PASS**