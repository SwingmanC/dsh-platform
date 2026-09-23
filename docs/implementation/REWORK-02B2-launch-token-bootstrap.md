# REWORK-02B2 — Launch Token Gateway Bootstrap

> 完成日期:2026-09-16
> 目标:dsh 0.1.5-rc.2 的 launch-token 浏览器 bootstrap;WS PARTIAL → PASS
> 沙箱:`.tools/dsh-0.1.5-rc.2/`(全局 dsh 0.1.1-rc.2 未动)
> 关联:`ADR-0001-launch-token-bootstrap-authority.md`

---

## 结论:PASS

全部 Gate 通过。**WebSocket 由 PARTIAL 升级为 PASS。**

---

## 1. Gateway bootstrap 完整请求链

```text
Browser  GET /                        (Host: localhost:8080, 无 dsh cookie)
  ↓
Gateway  preHandler
  ├─ sessions.readPrincipal(req)       平台 sid 认证
  ├─ ensureRuntime(principal)          取/拉起该用户 runtime(含内存 launchToken)
  └─ shouldBootstrap?
       launchToken != null
       && path == '/'
       && (lastBootstrappedSid != sid || 无 dsh-auth-* cookie)
  ↓ 是
Gateway  withBootstrapLock(runtime)
  └─ exchangeLaunchToken(runtime)
       node:http GET  http://127.0.0.1:<port>/?token=<launchToken>
       headers: { host: localhost:8080 }        ← 与代理阶段一致(ADR-0001)
       redirect: 不 follow
  ↓
DSH      ?token= 交换
       → 303 Location: /
       → Set-Cookie: dsh-auth-<authority hash>=...; HttpOnly; SameSite=Strict; Path=/
  ↓
Gateway  原样转发 303 + Location + Set-Cookie(不 follow)
  ↓
Browser  收到 303 → 跟随到干净 /
Browser  GET /  (带 dsh-auth cookie)
  ↓
Gateway  普通代理(getUpstream → runtime.upstreamUrl, Host 覆写 authority)
  ↓
DSH      200 + DSH Web UI HTML
```

**关键点:** token 只出现在 `Gateway→DSH` 的这条 upstream 请求中;浏览器 URL、响应体、DB、日志均无 token。

## 2. Runtime token 生命周期

| 阶段 | 行为 |
|---|---|
| 获取 | Supervisor 解析子进程 stdout `dsh web: http://127.0.0.1:<port>/?token=<t>`,用 `new URL()` 提取 |
| 存储 | `RuntimeInfo.launchToken`(**仅内存**);不写 MySQL、不写 audit、不进浏览器 API |
| 使用 | 仅用于 `GET /?token=` 一次性 cookie 交换;不用于 `/api`、`/plugins`、Authorization、WS query |
| 退出 | 子进程 exit 时 `launchToken = null`、`bootstrapInFlight = null`、`lastBootstrappedSid = null` |
| restart | 新进程 → 新 token;旧 token 不复用 |
| 并发 | `RuntimeInfo.bootstrapInFlight` 串行锁,避免并发 root 请求同时消费 |

## 3. Set-Cookie / 303 行为(实测)

```
HTTP/1.1 303 See Other
location: /
set-cookie: dsh-auth-ix_cRL2vnWt736i0dIZMvFdGc5O-RGhwRibrq14__qg=v1.eyJ2ZXJzaW9uIjoxLCJhdXRob3JpdHkiOiJsb2NhbGhvc3Q6ODA4MCIsImlzc3VlZEF0IjoxNzg5NjE1MTk1NTkyLCJleHBpcmVzQXQiOjE3OTIyMDcxOTU1OTJ9.<sig>; Max-Age=2592000; Path=/; Expires=...; HttpOnly; SameSite=Strict
content-length: 0
```

- cookie 载荷解码:`{"version":1,"authority":"localhost:8080","issuedAt":...,"expiresAt":...}`
- **authority = `localhost:8080`**(平台专属 authority),与后续代理请求的 Host 一致
- `Location: /` 为相对路径,浏览器解析到当前 origin,**不含 token**

## 4. HTTP 结果

| 场景 | 结果 |
|---|---|
| 未登录 `GET /`(无 cookie) | **302** → `http://localhost:5173/login` ✅ |
| 未登录 WS `/api/remote` | **302** ✅ |
| 登录后首次 `GET /`(无 dsh cookie) | **303** + `location: /` + `set-cookie: dsh-auth-*` ✅ |
| 带 dsh cookie `GET /` | **200**,body 28736 bytes(DSH Web UI) ✅ |
| 并发 5× `GET /` | **303, 303, 303, 303, 303**,无 error 日志 ✅ |
| 浏览器 URL 是否含 token | 否(`location: /`) ✅ |

## 5. WebSocket 结果:**PASS**

```text
/api/remote -> 101 UPGRADE (WS PASS)
```

- 端点:`/api/remote`
- 前置:平台 sid + dsh-auth cookie(完成 bootstrap 后)
- 未完成 bootstrap / 未登录 → 302(不泄漏)
- 修复前 PARTIAL 的原因:缺少 dsh-auth cookie → 升级被拒;完成 bootstrap 后升级成功。

## 6. Runtime restart 后重新 bootstrap

| 步骤 | 结果 |
|---|---|
| kill dsh 子进程(PID 27344) | — |
| 新浏览器(无 cookie)`GET /` | **303** + **新 cookie**(`issuedAt` 1789615766642,与旧值 1789615195592 不同) ✅ |
| 带新 cookie `GET /` | **200** ✅ |

- 新进程产生新 launch token;旧 token 未复用。
- 旧 cookie 因 HMAC secret 持久(`$DSH_HOME/.credentials.yaml`)在有效期内仍可用(官方设计)。

## 7. 多用户隔离测试

| 用户 | bootstrap | 带 cookie | 所属 runtime |
|---|---|---|---|
| A `admin@local.dev`(tenant default) | 303 | 200 | PID 27768, port **58939** |
| B `userb@local.dev`(tenant-b) | 303 | 200 | PID 6944, port **52609** |

**账号切换(同一浏览器):**

| 步骤 | 结果 |
|---|---|
| 以 A 登录 + bootstrap | 303(得 cookie A) |
| 同一 jar 切换登录为 B | — |
| B `GET /`(浏览器仍持 A 的 cookie) | **303**(因平台 sid 变化而重新 bootstrap)✅ |
| B 带新 cookie `GET /` | **200** ✅ |

- **路由完全由平台 session 决定**(`ensureRuntime(principal)`),DSH cookie 不参与路由。
- A 的 DSH cookie 无法访问 B 的 runtime(A 的 cookie 由 A runtime 的 HMAC 签名,B runtime 校验失败)。
- 采用 **sid 维度**跟踪 bootstrap(`lastBootstrappedSid`),解决 dsh cookie 按 authority 命名、多账号共用浏览器时的串 cookie 问题。

## 8. token 日志泄漏扫描

| 检查 | 结果 |
|---|---|
| gateway 日志 `?token=<未脱敏>` 命中 | **0** |
| gateway 日志 `token=` 任意命中 | **0** |
| gateway 日志可疑长 token 值 | **0** |
| `t_dsh_audit_events` 含 token | **0** |
| `t_dsh_runtimes` 列 | `dsh_version,host,id,last_heartbeat,pid,state,user_id`(**无 token 列**) |
| 浏览器 URL / 响应体 | 无 token |

- 启动行本身**从不写入日志**(仅内存解析)。
- `redactToken()` 对子进程 stderr 做 `?token=<v>` → `?token=[REDACTED]` 兜底。

## 9. 修改文件清单

| 文件 | 变更 |
|---|---|
| `apps/gateway/src/supervisor.ts` | `RuntimeInfo` +`launchToken`/`bootstrapInFlight`/`lastBootstrappedSid`;`new URL()` 解析启动行;`redactToken()`;exit 清空 token |
| `apps/gateway/src/proxy.ts` | 新增 bootstrap:`shouldBootstrap`/`exchangeLaunchToken`(node:http)/`withBootstrapLock`;转发 303+Location+Set-Cookie |
| `docs/implementation/adr/ADR-0001-launch-token-bootstrap-authority.md` | **新建** authority 一致性决策 |
| `docs/implementation/REWORK-02B2-launch-token-bootstrap.md` | **新建** 本报告 |

Gate 证据:`pnpm build` / `pnpm typecheck` / `pnpm test` 均 **EXIT 0**。

## 10. 是否满足进入 02B3 的 Gate

| Gate 条件 | 结果 |
|---|---|
| 未登录不能访问 DSH | **PASS**(302) |
| 登录后 root bootstrap 303→cookie→200 | **PASS** |
| 浏览器地址无 token | **PASS**(location `/`) |
| token 不在 log/DB | **PASS** |
| API PASS | **PASS**(HTTP 200 经代理) |
| WS PASS | **PASS**(101) |
| Runtime restart PASS | **PASS**(新 token) |
| A/B 用户不串 Runtime | **PASS**(独立进程/端口) |

**结论:满足进入 02B3 的 Gate。**

---

## 已知限制(留待后续)

1. **一次性 token 的复用性**:实测同一 token 可被多次交换(多浏览器各自得 cookie);`withBootstrapLock` 仍串行化以规避竞态。
2. **旧 cookie 跨 restart**:HMAC secret 持久,旧 cookie 在有效期内仍可用(官方设计,非缺陷)。
3. **未覆盖**:真实浏览器渲染验证(本阶段用 HTTP/WS 客户端,未用浏览器);02B4 补。
4. 测试进程与沙箱仍在本机(`.tools/` gitignored);全局 dsh 0.1.1-rc.2 未动。
