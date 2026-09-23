# REWORK-04 — Skill Contract (Official dsh-v0.1.5-rc.2)

> 真源:`.tools/dsh-0.1.5-rc.2/node_modules/@deepseek-ai/dsh-skill/lib/types/index.d.ts`
> 版本:`0.1.5-rc.2` (package.json)
> 生成日期:2026-09-18

---

## 1. SkillRegistry(`ctx.skills`)

`@deepseek-ai/dsh-skill` 包的 Service Definition。
插件以 `inject = ['skills']` 声明依赖,注册 `ctx.skills.registerProvider`。

```ts
declare module '@deepseek-ai/cordis' {
  interface Context { skills: SkillRegistry }
}
```

### registerProvider

```ts
registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void
```

- 在 `apply(ctx)` 期间同步调用
- 返回 disposer → dispose 时注销 provider + 使缓存失效
- 同一层内重名 provider 名抛异常
- 保留名:`runtime`

### register (runtime skill 快捷注册)

```ts
register(skill: SkillRegistration): () => void
```

- 运行时技能(本阶段不使用,仅记录)

### list / snapshot / get

```ts
list(options?: SkillViewOptions): Promise<SkillSummary[]>
snapshot(options?: SkillViewOptions): Promise<SkillCatalogSnapshot>
get(name: string, options?: SkillViewOptions): Promise<SkillDefinition | undefined>
```

---

## 2. Provider Interface

```ts
interface SkillProvider {
  readonly name: string
  readonly list: (options: SkillLookupOptions) =>
    Promise<readonly SkillCandidate[] | SkillProviderObservation>
  readonly get: (candidate: SkillCandidate, options: SkillLookupOptions) =>
    Promise<SkillDefinition | undefined>
}
```

### SkillLookupOptions

```ts
interface SkillLookupOptions {
  readonly cwd?: string | undefined
  readonly signal?: AbortSignal | undefined
}
```

### SkillProviderControl

```ts
interface SkillProviderControl {
  readonly signal: AbortSignal
  readonly invalidate: () => void
}
```

- `signal.aborted === true` → provider 应尽快停止工作
- `invalidate()` → 清空已完成缓存并通知 consumer

---

## 3. Candidate / Definition / Summary

### SkillSummary

```ts
interface SkillSummary {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillInvocationPolicy
  readonly source: SkillSource
  readonly provider: string
  readonly resourceBase?: SkillResourceBase
}
```

### SkillCandidate (extends SkillSummary)

```ts
interface SkillCandidate extends SkillSummary {
  readonly rank: number
  readonly locator: unknown
  readonly path?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}
```

### SkillDefinition (extends SkillSummary)

```ts
interface SkillDefinition extends SkillSummary {
  readonly content: string
  readonly path?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}
```

---

## 4. Invocation Policy

```ts
interface SkillInvocationPolicy {
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}
```

两轴独立:
- `modelInvocable` → 模型端 catalog 可见
- `userInvocable` → 用户端命令可见
- 两者均 `false` → 仅受信 `get()` 调用方可访问

---

## 5. Source / ResourceBase / Rank

### SkillSource

```ts
type SkillSource = 'project-dsh' | 'project-agents' | 'runtime' | 'user-dsh'
  | 'user-agents' | 'custom' | 'bundled' | (string & {})
```

本 Provider 使用 `'custom'`。

### SkillResourceBase

```ts
type SkillResourceBase =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'opaque'; readonly description: string }
```

本阶段无平台受控 artifact 存储 → 使用 `{ kind: 'opaque', description: '...' }`。

### 内置 rank 表

| rank | source | 说明 |
|------|--------|------|
| 100 | project-dsh | `<projectRoot>/.dsh/skills` |
| 200 | project-agents | `<projectRoot>/.agents/skills` |
| 300 | custom | `Config.customSkillDirs` |
| 400 | user-dsh | `<dshHome>/skills` |
| 500 | user-agents | `<agentsHome>/skills` |
| 600 | bundled | `Config.bundledSkillDir` |

`BUNDLED_SKILL_RANK = 600` (常量导出)。

---

## 6. Skill 名称约束

```ts
/^[a-z0-9]+(?:-[a-z0-9]+)*$/
```

kebab-case,不允许大写/下划线/空格。

---

## 7. events

```ts
'skills/change'(): void  // emit
```

Provider 变更/注册表变更时发出;consumer 自行 refetch。

---

## 8. cmcc-platform contract mapping

| 官方符号 | cmcc 实现 |
|----------|-----------|
| `name` | 平台 slug(kebab-case) |
| `description` | DB `description` ?? `name` |
| `invocation` | `{ modelInvocable: true, userInvocable: true }` |
| `source` | `'custom'` |
| `provider` | `'cmcc-platform'` |
| `rank` | `350` (见 ADR-0002) |
| `locator` | `{ id, version }` opaque object |
| `resourceBase` | `{ kind: 'opaque' }` |
| `content` | DB `prompt` 文本 |