# REWORK-07 — DSH 0.1.5-rc.2 Memory Seam 审计

> 日期:2026-09-18
> 真源:`.tools/dsh-0.1.5-rc.2/node_modules/@deepseek-ai/`

---

## 1. 结论:无官方长期 Memory Registry

```text
ctx.memory            = 不存在
memory registry       = 不存在
long-term-memory svc  = 不存在
```

**不得发明 `ctx.memory`。** 平台自行实现 Memory Store(authoritative),DSH 只消费受治理的派生数据。

## 2. 官方可用 seam

| 用途 | 官方 seam | exact contract |
|------|-----------|----------------|
| model-facing memory tools | `ctx.tools` | `register(ToolDefinition)` / `schemas()` / `execute()` |
| bounded recall 注入 | `ctx.systemPrompt.context(PromptContext)` | 动态 **user-role** context snapshot |
| completed-turn 触发 | `ctx.on('session/event', (session, event))` | `event.type==='turn/end'` + `event.data.reason.kind` |
| turn 边界 | `turn/start` / `turn/end` | `turn/end.data.reason = {kind:'completed'\|'blocked'\|'aborted'\|'error'\|'max-tokens'}` |
| session 读取 | `session.snapshotEvents()` / `session.id` | 只读事件日志 |

## 3. 8 个问题回答

1. **是否有官方长期 Memory Registry?** 否。
2. **是否有官方 model-facing Tool seam?** 是:`ctx.tools`。
3. **是否有官方 system-prompt/context contribution seam?** 是:`ctx.systemPrompt.context`(动态 user-role)与 `ctx.systemPrompt.section`(system)。
4. **是否有官方、安全可用的 completed-turn/session event hook?** 是:`ctx.on('session/event', ...)`,`turn/end` 携带 `reason.kind`。
5. **哪个 seam 用于 recall?** `ctx.systemPrompt.context` — **user-role** 动态 context(非 system section),保证 Memory 不作为高优先级指令。
6. **哪个 seam 用于 explicit memory tools?** `ctx.tools`。
7. **哪个 seam 用于 automatic extraction?** `session/event` 的 `turn/end`(仅 `kind==='completed'`)。
8. **哪些能力 fixed tag 不支持?** 官方 Memory Registry / 自动 prompt 注入 policy / vector memory。

## 4. Recall 注入选择理由

- `PromptContext` 被 materialize 为 **durable user-role snapshot**(官方注释明确)
- 与 system/developer 指令分离 → Memory 内容不会越权
- 每次 assembly 用 `AssembleContext`(含 `agent`)求值 → 可读取当前 session 最近用户消息做 query
- 有 disposer,生命周期安全

## 5. Extraction 选择理由

- `turn/end` 的 `reason.kind === 'completed'` 表示成功完成的 turn
- `aborted` / `error` / `blocked` / `max-tokens` 不触发提取
- `session/event` 是 post-commit fire-and-forget feed(构造 seed 不重放)→ 天然避免 restart replay 重复

## 6. 平台实现映射

| 平台职责 | DSH seam |
|----------|----------|
| Memory Store(authoritative) | 平台 DB |
| per-user projection | Gateway 派生文件 |
| recall | `ctx.systemPrompt.context` |
| tools | `ctx.tools` |
| extraction 触发 | `session/event` → `turn/end` completed |
| 写回 | Gateway internal mutation channel(per-runtime ephemeral token) |