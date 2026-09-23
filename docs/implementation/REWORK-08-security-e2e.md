# REWORK-08 — Security E2E

> 日期:2026-09-18
> 脚本:`scripts/final-e2e/secret-scan.mjs`、`security-browser.mjs`、`concurrency.mjs`

---

## 1. Secret Final Scan

扫描范围:git tracked files、全仓工作树(排除 node_modules/.git/.tools)、生成 profile/patch、DSH_HOME、projection、Gateway logs、runtime 目录。

| Secret | git tracked | 工作树 | runtime artifacts |
|--------|-------------|--------|-------------------|
| `PLATFORM_TEST_DEEPSEEK_API_KEY` | 0 | 1(仅 `.env`,已 gitignore) | 0 |
| `PLATFORM_SECRET_ENCRYPTION_KEY`(E2E 测试值) | 0 | 0 | 0 |
| `SESSION_SECRET`(E2E 测试值) | 0 | 3(E2E harness 常量,非真实) | 0 |
| `MYSQL_PASSWORD` | 0 | 1(仅 `.env`) | 0 |

- 生成 patch(`var/final-e2e/homes/**/profiles/web/platform-patch.yml`)只含 `!!js` env 引用,无 secret value。
- DSH launch token:仅存 supervisor 内存,浏览器 URL 与日志均无(`redactToken`)。
- runtime ephemeral token:仅存 internal-channel 内存。
- MCP plaintext secret:DB 只存 AES-256-GCM ciphertext envelope。

**结果:PASS(无不应出现的明文 secret;测试 key 仅存在于 gitignore 的 `.env`)**

## 2. Browser Cookie / Storage Gate

| Cookie | HttpOnly | SameSite | 说明 |
|--------|----------|----------|------|
| `sid` | true | Lax | 平台会话 |
| `device_id` | true | Lax | 设备标识 |
| `csrf_token` | false | Lax | 双提交 CSRF(设计上非 HttpOnly) |
| `dsh-auth-*` | true | Strict | DSH 浏览器会话 |

- URL 不含 launch token。
- `localStorage` / `sessionStorage` 键集合为空(无 secret 落 Web Storage)。
- `Secure=false` 仅因本地 http 开发;生产 HTTPS 下置 Secure。

**结果:PASS**

## 3. Multi-user 隔离

| 检查 | 机制 | 结果 |
|------|------|------|
| 平台 API 跨用户 | repository SQL `owner/tenant` 过滤 | PASS(Phase 03–07 回归 + 5-user smoke) |
| Runtime 投影跨用户 | per-user 目录 + SQL principal 过滤 | PASS(Phase 04–07 A/B E2E) |
| Skill/Knowledge/MCP/Memory A/B | 独立 tenant/user/投影/token | PASS(Phase 04–07) |
| 5-user 并发 | 独立 sid/runtimeId,0 串用户 | PASS(`concurrency.mjs`) |

> 会话级(浏览器对话)跨用户验证受 B5 阻塞影响,未执行;API/投影级隔离已充分验证。

## 4. Runtime → Gateway 写回认证

- per-runtime ephemeral token(仅内存),`x-runtime-token` 反查身份;不接受 body/query 身份。
- Runtime 退出即轮换/吊销;不落 DB/浏览器/日志。

## 5. 已知允许限制

```text
Knowledge retrieval = LEXICAL_V1
Memory retrieval    = LEXICAL_V1
MCP stdio           = DISABLED
MCP tool trial API  = DISABLED_BY_POLICY
Team memory runtime = DISABLED
```

**Security E2E = PASS(会话级 A/B 因 B5 未执行)**