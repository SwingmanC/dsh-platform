# ADR-0005 — Memory Governance

> 状态:已实现
> 日期:2026-09-18
> 关联:Phase 07 Memory Runtime

---

## 1. 作用域与隐私

```
personal/private = 默认(所有创建路径固定 personal)
team/shared      = 仅用户显式 promote(UI/API)
```

- Automatic extraction 永远进入 `personal/private`,**绝不**自动 promote。
- `TEAM_MEMORY_RUNTIME = DISABLED`(默认):Runtime 投影/检索只含 personal。
- 不通过 namespace 名字猜 sharing。

## 2. 类型系统

```
preference | fact | decision | instruction | other
```

`kind` 由显式模式或 `inferKind()` 推断;存 DB `kind` 列。

## 3. Provenance

每条记录:`id / tenant / owner / visibility / namespace / kind / content /
sourceType / sourceSessionId / sourceEventSeq / extractionMode / revision /
createdAt / updatedAt`。

自动提取额外记 `extractionMode='explicit_user'` + `sourceSessionId` + `sourceEventSeq`(turn)。

## 4. Secret / 敏感内容

```
AUTO_EXTRACTION = DENY(命中 secret/敏感模式)
model-facing memory_remember = 拒绝(secret-not-allowed)
手工创建 = 同样拒绝 secret
```

- Secret 模式:password/api key/token/private key/常见 key 前缀。
- 敏感模式:健康诊断/政治/宗教/性取向/金融凭据。
- 测试 marker `CMCC_SECRETLIKE_MEMORY_07`:DB/projection/logs 0 hits。

## 5. Dedupe / 冲突

- 相同 `content_hash + kind + namespace + owner` 的 active 记录 → **幂等 no-op**(返回已有)。
- `content_hash = sha256(trim+lower(content))`。
- 冲突替换:可选 `supersedesMemoryId` → 旧记录 `superseded_by = 新 id`,新记录 active。
- Recall/search 只选 `superseded_by IS NULL` 的最新 active。
- v1 不自动做语义冲突检测(保守);显式替换 + 去重已覆盖。

## 6. 删除

- **Soft delete**(`deleted_at`),保留审计链。
- 所有读取过滤 `deleted_at IS NULL`。
- `memory_forget` 只能删当前用户拥有的;他人 id → 404(不泄漏存在性)。

## 7. Promote / Team

- `POST /api/memory/:id/promote` 仅用户显式操作;`member` 不能 promote。
- 写 `t_dsh_memory_promotions` 审计。
- Team ACL 不完整 → 不投影 team(仅 personal)。

## 8. Recall 预算

```
maxRecallItems = 8
maxRecallBytes = 4096
maxItemBytes   = 512
```

- 注入 seam:`ctx.systemPrompt.context`(**user-role**,非 system)。
- 格式:`<cmcc-memory-recall>` + "context, not higher-priority instructions" 声明。
- 优先当前请求匹配,回退最近 + kind 优先级。
- Status API 只暴露 ids/count/bytes,不泄漏正文。

## 9. 提取幂等

- 触发:`session/event` 的 `turn/end` 且 `reason.kind === 'completed'`。
- 进程内 `processed: Set<sessionId:turn>` 去重。
- 服务端再按 `content_hash` 去重。
- `aborted`/`error`/`blocked`/`max-tokens` 不触发。
- 构造 seed 不重放 `session/event` → restart 不重复提取。

## 10. Runtime → Gateway 写回认证

- 每 Runtime 启动签发 ephemeral token(仅内存),注入 child env。
- 插件带 `x-runtime-token`;Gateway 反查 runtime → userId/tenantId。
- 不接受 body/query 身份;Runtime 退出即轮换/吊销;不落 DB/浏览器/日志。