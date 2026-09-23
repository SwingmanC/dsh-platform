# ADR-0002 — CMCC Platform Skill Precedence (Rank)

> 状态:已实现
> 日期:2026-09-18
> 关联:Phase 04 Skill Runtime Projection

---

## 上下文

DSH 0.1.5-rc.2 内置 rank 表:

| rank | source | 说明 |
|------|--------|------|
| 100 | project-dsh | `<projectRoot>/.dsh/skills` |
| 200 | project-agents | `<projectRoot>/.agents/skills` |
| 300 | custom | `Config.customSkillDirs` |
| 400 | user-dsh | `<dshHome>/skills` |
| 500 | user-agents | `<agentsHome>/skills` |
| 600 | bundled | `Config.bundledSkillDir` |

平台安装的 Skill 需要一个插入优先级位置。

## 决策

**rank = 350**

```ts
export const CMCC_PLATFORM_SKILL_RANK = 350
```

## 语义

```
project-dsh (100)
project-agents (200)
custom (300)
    ↓
CMCC 平台已安装 Skill (350)  ← 本 Provider
    ↓
user-dsh (400)
user-agents (500)
bundled (600)
```

含义:
- **显式项目配置**(project-dsh/project-agents/custom)优先于平台 Skill
- **平台已安装 Skill**优先于用户目录/bundled
- 单层内重名按 rank → provider order → local order 裁决

## 原因

1. 平台 Skill 是组织级可信安装,应优先于用户自行下载的 skill
2. 但不应覆盖开发者本地项目显式配置
3. 350 在 custom(300)和 user-dsh(400)之间的间隙,不与其他内置 rank 冲突

## 碰撞测试

如果同一个 skill name 同时存在于:
- project `.dsh/skills/<name>` → rank 100 → 不会碰撞(350 < 100? NO, 350 > 100, 实际上 lower rank wins。注册表单层内:lower rank wins。所以 project-dsh (100) 会赢平台 (350))

Wait, 修正:官方文档说「Lower ranks win duplicate skill names before provider registration order is considered.」所以在单层内,低 rank 胜出。

但平台插件注册在全局层,project-dsh 也在全局层。所以:
- `greeting` 在 project `.dsh/skills/greeting` (rank 100) → wins
- `greeting` 在平台已安装 (rank 350) → loses

这符合预期:项目显式配置优先于平台默认。

如果 `greeting` 只在平台安装:
- rank 350 → wins (对 user-dsh rank 400)
- rank 350 → wins (对 bundled rank 600)

## 禁止依赖 provider registration order

Provider registration order 只在同 rank + 同层内做 tiebreaker。本 Provider 不依赖其他 provider 的注册顺序。