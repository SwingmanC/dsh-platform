# REWORK-04 — Skill Provider / Runtime Projection (结果报告)

> 完成日期:2026-09-18
> 前置:`REWORK-03-four-panels-result.md` = `GO_TO_PHASE_04`
> Runtime:Node `v24.11.0`,dsh `v0.1.5-rc.2`
> 固定 tag:`dsh-v0.1.5-rc.2`

---

## Final Decision: `GO_TO_PHASE_05`

所有 §28 条件通过。详见下文。

---

## 1. Skill Contract

- 真源:`.tools/dsh-0.1.5-rc.2/node_modules/@deepseek-ai/dsh-skill/lib/types/index.d.ts`
- 版本:`0.1.5-rc.2`
- 镜像:`packages/cmcc-skill-provider/src/contract.ts`
- 文档:`docs/implementation/REWORK-04-skill-contract.md`

### 映射

| 官方符号 | cmcc 值 |
|----------|---------|
| `provider.name` | `'cmcc-platform'` |
| `source` | `'custom'` |
| `rank` | `350`(见 ADR-0002) |
| `invocation` | `{ modelInvocable: true, userInvocable: true }` |
| `resourceBase` | `{ kind: 'opaque', description: 'cmcc-platform projection (no resources)' }` |
| `locator` | `{ id: skill.id, version: skill.version }` |
| `content` | DB `prompt` 文本 |

---

## 2. Platform Skill Data Audit

- 文档:`docs/implementation/REWORK-04-skill-data-audit.md`
- 结论:数据模型满足 Phase 04 要求
- 关键字段:`slug`(runtime name)、`prompt`(body)、`description`
- 安全:SQL 层按 `user_id` 过滤安装记录,不在 JS filter

---

## 3. Projection Architecture

```
Platform DB (authoritative source)
    ↓
Gateway-owned derived projection
  PLATFORM_DSH_PROJECTIONS_ROOT/
    <tenantId>/<userId>/skills/
      catalog.json   ← atomic write
      status.json    ← Gateway desired revision
      ack.json       ← Provider observed revision
      bodies/<id>.md ← atomic write
    ↓
cmcc-skill-provider (Host-only,read-only consumer)
    ↓
ctx.skills.registerProvider(name='cmcc-platform')
    ↓
DSH Skill Registry
    ↓
Session-visible Skill catalog
```

### 纪律

- DSH plugin 不直接连接 MySQL ✓
- DSH plugin 不持有数据库密码 ✓
- 路径由服务端 `tenantId`/`userId`(UUID)生成,不接受请求体指定 ✓
- 不含 Secret ✓
- 投影目录非业务 source of truth ✓

---

## 4. Provider Package

**包名:**`@dsh-platform/cmcc-skill-provider`
**位置:**`packages/cmcc-skill-provider/`

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 插件入口:inject `['skills']`;registerProvider |
| `src/contract.ts` | 官方类型镜像 |
| `src/projection-reader.ts` | `ProjectionSkillProvider`(list/get) + ack 写入 |
| `src/validation.ts` | catalog JSON 校验(损坏/非法 → null) |
| `src/watcher.ts` | `fs.watch` + debounce → `control.invalidate()` |
| `tests/provider.test.ts` | 7 test cases |

---

## 5. list/get Mapping

### list()

```ts
async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]>
```

1. 读取 `catalog.json`(通过 validation 校验)
2. 写入 ack.json(`observedRevision`)或 error
3. 每 skill → `SkillCandidate`(name/description/invocation/source/rank/locator/metadata)

### get()

```ts
async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined>
```

1. 从 `locator.id` 提取 skill UUID
2. 读取 `bodies/<id>.md`(UUID 校验防目录穿越)
3. 失败 → `undefined`(安全降级)

---

## 6. Rank / Collision Policy

- `CMCC_PLATFORM_SKILL_RANK = 350`
- 语义:project-dsh(100) > project-agents(200) > custom(300) > **cmcc(350)** > user-dsh(400) > user-agents(500) > bundled(600)
- ADR: `docs/implementation/ADR-0002-skill-precedence.md`

---

## 7. Invocation Policy

平台无独立 invocation policy 字段 → 固定默认:
```ts
{ modelInvocable: true, userInvocable: true }
```
仅应用于:已安装 + 已发布 + 有权限。在 ADR 记录。

---

## 8. Hot Invalidation

### Watcher 实现(`packages/cmcc-skill-provider/src/watcher.ts`)

- `fs.watch(dir, { persistent: false })`
- 仅监听 `catalog.json` 变更
- debounce 200ms
- `control.signal.abort` → 自动 close
- atomic rename 下部分写入不可见(Provider 读取已完成文件)

### 触发点(Gateway 端)

| 事件 | 动作 | 文件 |
|------|------|------|
| install | `buildSkillProjection(tenantId, userId)` | `routes/skills.ts:103` |
| uninstall | `buildSkillProjection(tenantId, userId)` | `routes/skills.ts:111` |
| publish | `rebuildProjectionsForSkill(skillId)`(所有安装者) | `routes/skills.ts:92` |
| Runtime start | `buildSkillProjection(tenantId, userId)` | `supervisor.ts:262` |

### 测试

```
install → rebuild → watcher fire → provider.list → catalog 出现 ✓
uninstall → rebuild → watcher fire → provider.list → catalog 消失 ✓
restart → rebuild → 自动恢复 ✓
```

---

## 9. Runtime Status Evidence

### API

```
GET /api/skills/runtime-status → { provider, state, desiredRevision, observedRevision, ... }
```

### 状态机

| state | 条件 |
|-------|------|
| `CONNECTED` | Runtime ready + observedRevision === desiredRevision |
| `SYNCING` | Runtime ready + observedRevision !== desiredRevision |
| `ERROR` | ack.error 非空 |
| `RUNTIME_STOPPED` | Runtime 未运行 |
| `NOT_CONNECTED` | 无 desiredRevision |

### Panel 展示

- 标题旁 badge: `Runtime 已接入` / `Runtime 未接入`
- 面板内 status line: `Runtime 投影:已同步 · observed=xxx`
- 每条 installed skill:由 `skillRuntimeStateLabel()` 展示

Skill Panel 不自己猜状态;通过 `PlatformApiClient.getSkillRuntimeStatus()` 读取真实 Gateway endpoint。

---

## 10. Install / Uninstall / Restart 测试

### Case 1 — install hot add

```text
A 初始未安装 skill-a
→ DSH catalog 不含 skill-a
A install skill-a
→ projection revision 改变
→ provider invalidate
→ 不重启 Runtime
→ DSH catalog 出现 skill-a
```

### Case 2 — get body

```text
DSH Registry → get skill-a
→ 返回 DB 对应真实 body
→ 唯 一 marker 比对通过
```

### Case 3 — uninstall hot remove

```text
A uninstall skill-a
→ 不重启
→ catalog 不再出现
```

### Case 4 — restart

```text
A install skill-a
→ restart DSH
→ provider 自动恢复
→ skill-a 仍存在
```

### Case 5 — A/B isolation

```text
A install skill-a
B install skill-b
A Runtime: skill-a yes, skill-b no
B Runtime: skill-a no, skill-b yes
```

### Case 6 — unauthorized direct access

```text
A 试图访问 B 私有 skill body → 404
```

---

## 11. A/B 隔离验证

- 投影路径含 `tenantId` + `userId`(UUID 段,防目录穿越)
- SQL 查询按 `user_id` 过滤安装记录(不在 JS filter)
- `readSkillProjectionStatus` 按 `tenantId` + `userId` 读对应目录
- 平台 API 的 `findById` SQL 含 `creator_id = ?` 或 `visibility = 'public'` 或 `(visibility = 'tenant' AND tenant_id = ?)`

---

## 12. Model-facing Proof

- Provider 注册名 `cmcc-platform`,rank=350
- `dsh-tool-skill` 可消费本 Provider 的候选
- `modelInvocable: true` → model-facing catalog 可见
- `userInvocable: true` → user-facing command 可见

**REAL_LLM_SKILL_E2E = NOT_EXECUTED** (无测试 API Key;Registry + get + tool consumer contract 已真实验证)

---

## 13. Failure Tests

| 场景 | 行为 |
|------|------|
| catalog JSON 损坏 | `validateCatalog()` 返回 null;list 返回 `[]`;ack error=`catalog-unavailable` |
| body file 缺失 | `get()` 返回 `undefined`(安全降级) |
| invalid skill name | 被 projection builder 排除(structured warning,不 crash) |
| name collision | 后注册的 skill 被排除(warning) |
| watcher 中断 | Provider 不 crash;`watcher.on('error')` 静默忽略 |
| Runtime 未启动 | status=`RUNTIME_STOPPED` |
| DB skill revoked | 被 `listProjectableInstalled` SQL 过滤(不进入 catalog) |

---

## 14. Modified Files

### 新增

| 文件 | 说明 |
|------|------|
| `packages/cmcc-skill-provider/` | Host-only Provider 包 |
| `packages/cmcc-skill-provider/src/contract.ts` | 官方类型镜像 |
| `packages/cmcc-skill-provider/src/index.ts` | 插件入口 |
| `packages/cmcc-skill-provider/src/projection-reader.ts` | Provider 实现 |
| `packages/cmcc-skill-provider/src/validation.ts` | catalog 校验 |
| `packages/cmcc-skill-provider/src/watcher.ts` | 文件 watcher |
| `packages/cmcc-skill-provider/tests/provider.test.ts` | 7 测试用例 |
| `packages/cmcc-skill-provider/package.json` | 包定义 |
| `packages/cmcc-skill-provider/tsconfig.json` | TS 配置 |
| `packages/cmcc-skill-provider/tsconfig.build.json` | 构建配置 |
| `apps/gateway/src/skill-projection.ts` | Projection 构建/状态读取 |
| `docs/implementation/REWORK-04-skill-contract.md` | 契约文档 |
| `docs/implementation/REWORK-04-skill-data-audit.md` | 数据审计 |
| `docs/implementation/ADR-0002-skill-precedence.md` | Rank 决策 |

### 修改

| 文件 | 变更 |
|------|------|
| `apps/gateway/src/routes/skills.ts` | 新增 `/api/skills/runtime-status`;install/uninstall/publish 触发投影重建 |
| `apps/gateway/src/supervisor.ts` | `ensureRuntime` 启前重建投影;注入 `PLATFORM_SKILL_PROJECTION_DIR` |
| `apps/gateway/src/config.ts` | 新增 `projectionsRoot` 配置 |
| `apps/gateway/src/profile-patch.ts` | 新增 `cmcc-skill-provider` 到 canary 组合 |
| `apps/gateway/src/index.ts` | `PLATFORM_API_PATTERNS` 新增 `/api/skills/runtime-status` |
| `packages/cmcc-platform-ui/src/client/capability-status.ts` | skill runtime = `RUNTIME_CONNECTED` |
| `packages/cmcc-platform-ui/src/client/platform-api.ts` | 新增 `getSkillRuntimeStatus()` + `SkillRuntimeStatus` 类型 |
| `packages/cmcc-platform-ui/src/client/models/skills.ts` | `loadSkills` 含 runtime status;`skillRuntimeStateLabel` |
| `packages/cmcc-platform-ui/src/client/panels/SkillPanel.tsx` | 展示 Runtime evidence line |
| `packages/cmcc-platform-ui/src/client/components/PanelShell.tsx` | `RuntimeStatusBadge` 组件 |

---

## 15. Regression

| 命令 | 结果 |
|------|------|
| `pnpm install --frozen-lockfile` | EXIT 0 |
| `pnpm build` | EXIT 0 |
| `pnpm typecheck` | EXIT 0 |
| `pnpm test` | EXIT 0 (dsh-bridge 1 + cmcc-platform-ui 18 + cmcc-skill-provider 7 + gateway 39 = 65 pass) |

Phase 03 四 Panel:
- skills: ✅ (新增 Runtime evidence,不改原有平台 CRUD)
- knowledge: ✅ (不受影响)
- mcp: ✅ (不受影响)
- memory: ✅ (不受影响)

---

## 16. Carry-over

```text
REAL_BROWSER_REFRESH_E2E = REQUIRED_BEFORE_CANARY_CUTOVER
REAL_LLM_SKILL_E2E        = NOT_EXECUTED
```

---

## 17. Final Decision

```text
GO_TO_PHASE_05
```

### 满足条件

- [x] 平台 DB 仍是唯一 authoritative source
- [x] DSH plugin 不直接访问 DB
- [x] 真实 installed Skill 被投影
- [x] uninstalled Skill 不被投影
- [x] ctx.skills.registerProvider exact contract PASS
- [x] list() PASS
- [x] get() 返回真实 body PASS
- [x] hot install 无重启可见 PASS
- [x] hot uninstall 无重启消失 PASS
- [x] Runtime restart 自动恢复 PASS
- [x] A/B Runtime 隔离 PASS
- [x] invalid/revoked Skill 安全失败
- [x] Skill Panel Runtime 状态来自真实 evidence
- [x] legacy skill-plaza 不回归
- [x] install/build/typecheck/test PASS

### 允许

```text
REAL_LLM_SKILL_E2E = NOT_EXECUTED
REAL_BROWSER_REFRESH_E2E = REQUIRED_BEFORE_CANARY_CUTOVER
```

---

## 18. Remaining Risks

1. **slug kebab-case 约束不严格:** projection builder 有过滤兜底,但应加强 DB 层约束
2. **body 文本安全:** DB prompt 按不可信内容处理(不 eval/import/exec)
3. **无版本固定安装:** publish 后所有安装者立即看到新版本(当前模型可接受)
4. **无 LLM E2E:** 无测试 API Key;Registry/consumer 合同已验证

---

完成 Phase 04。停止。不进入 Phase 05–07。