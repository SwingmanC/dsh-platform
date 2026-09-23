# ADR-0001 — Launch-token bootstrap 与后续请求使用一致的 upstream authority 策略

- 状态:已采纳
- 日期:2026-09-16
- 关联:`REWORK-02B2-launch-token-bootstrap.md`

---

## 背景

DeepSeek Harness 0.1.5-rc.2 引入进程级 launch token 浏览器认证:

```text
Runtime start
→ stdout: http://127.0.0.1:<port>/?token=<launchToken>
→ GET /?token=...  (仅 root index)
→ 303 Location: /
→ Set-Cookie: dsh-auth-<authority hash>; HttpOnly; SameSite=Strict; Path=/
```

浏览器会话 cookie 是**签名且绑定 authority** 的 bearer:名称与签名载荷都包含
"规范化 hostname + port"。因此 token 交换阶段与后续 API/WebSocket 阶段
**必须让 DSH 看到同一个 authority**,否则:

- 交换阶段用 authority A → cookie 绑定 A;
- 后续请求用 authority B → DSH 校验失败 → 401。

## 决策

**Gateway 在 bootstrap 交换与后续所有代理请求中,使用完全相同的 Host 覆盖策略:**

```text
Host = PLATFORM_DSH_UI_AUTHORITY  (如 localhost:8080)
```

实现位置:

- `apps/gateway/src/proxy.ts` `upstreamHeaders()`(普通 HTTP/WS 代理)
- `apps/gateway/src/proxy.ts` `exchangeLaunchToken()`(token 交换)

两处都设置 `host: runtime.authority`(= `config.dsh.uiAuthority`)。

## 关键实现约束:必须使用 `node:http`,不能用 `fetch`/undici

实测发现:Node 的 `fetch`(undici)**禁止覆盖 `Host` 头**(fetch 规范中的 forbidden
header)。若用 `fetch` 做 token 交换,undici 会改用 URL 的 host(`127.0.0.1:<port>`),
导致:

```text
cookie payload authority = 127.0.0.1:57679   ← 错误(DSH 监听地址)
后续请求 Host           = localhost:8080      ← 不匹配
→ 401 Unauthorized
```

因此 `exchangeLaunchToken()` 使用 `node:http.request()`,可显式设置 `Host`。

## 实测证据

| 阶段 | Host 策略 | cookie authority | 后续请求 |
|---|---|---|---|
| 修复前(fetch) | 被 undici 忽略 → `127.0.0.1:<port>` | `127.0.0.1:57679` | 401 |
| 修复后(node:http) | `localhost:8080` | `localhost:8080` | 200 |

## 后果

- 正向:bootstrap 与 API/WS 单一 authority,无策略切换;cookie 校验通过。
- 约束:Gateway 必须始终知道目标 authority(来自配置),不能依赖 URL host。
- 约束:任何未来新增的 upstream 调用(如 session-sync 的 dsh RPC)也必须遵循同一策略。

## 备选方案

- **用 `fetch` 但改 URL host 为 authority**:不可行,authority 是公网名,无法解析到 loopback。
- **交换阶段用 `127.0.0.1:<port>`,后续也用 `127.0.0.1:<port>`**:需要浏览器也访问
  `127.0.0.1:<port>`,与专属 authority 拓扑冲突,且 `<port>` 每进程变化。
- **禁用 DSH token 认证**:明确禁止,且降低安全性。
