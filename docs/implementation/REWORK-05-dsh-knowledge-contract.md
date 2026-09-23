# REWORK-05 — DSH 0.1.5-rc.2 Knowledge Seam 审计

> 日期:2026-09-18
> 真源:`.tools/dsh-0.1.5-rc.2/node_modules/@deepseek-ai/`

---

## 1. 结论

**DSH 0.1.5-rc.2 不存在第一方 Knowledge/RAG Registry 服务。**

无 `ctx.knowledge`、`ctx.rag`、`ctx.retrieval` 等官方服务。不存在 Knowledge-specific Registry。

## 2. 选择:官方 `ctx.tools` 作为 Runtime Adapter

选择官方 `@deepseek-ai/dsh-tools` 的 `ToolRuntime` seam:

```
ctx.tools.register(toolDefinition)
ctx.tools.schemas(scope?)
```

### 工具

| tool name | 职责 |
|-----------|------|
| `knowledge_search` | 检索用户已授权 mounted KB 中匹配 query 的 chunks |
| `knowledge_read` | 根据 resultRef 读取完整 chunk 内容 |

### 为什么不修改 DSH core

- `ctx.tools` 是官方显式注册自定义工具的 seam
- 不需要修改 DSH 任何 core 包
- 不需要 `@deepseek-ai/dsh-knowledge` 或 `@deepseek-ai/dsh-rag`
- 工具 schema 直接走官方 `ToolSchema` 校验 + `ToolOutputDefinition` 渲染

## 3. 官方 ToolRuntime 契约

```ts
// 注册工具(同步)
ctx.tools.register(definition: ToolDefinition): () => void
// 列出 schema(面向 model/agent)
ctx.tools.schemas(scope?: ScopeKey): ToolSchema[]
```

### ToolDefinition

```ts
interface ToolDefinition extends ToolSchema {
  readonly output: ToolOutputDefinition
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  finalizeContent?(exec, result): ContentBlock[] | undefined
  timeoutMs?: number
}
```

### ToolSchema

```ts
// name, description, parameters(JSON Schema)
```

### ToolOutputDefinition

```ts
interface ToolOutputDefinition {
  readonly schema: JsonSchemaNode   // 输出 JSON Schema
  render(args: unknown, value: JsonValue): ContentBlock[]  // 模型可见渲染
}
```

## 4. defineTool 辅助

`@deepseek-ai/dsh-tools` 提供 `defineTool` 辅助:

```ts
defineTool(name, definition)
```

本插件使用 `defineTool` → `ctx.tools.register`。

## 5. Provider 约束

- 工具插件必须声明 `inject = ['tools']`
- 工具不直接访问 MySQL
- 工具经 Gateway projection 读授权数据
- 工具参数不接收 tenantId/userId/ownerId/absolute path/SQL