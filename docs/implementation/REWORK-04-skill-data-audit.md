# REWORK-04 — Platform Skill Data Model Audit

> 审计日期:2026-09-18
> 真源:`db/schema.sql` + `apps/gateway/src/repositories/skill-repository.ts` + `apps/gateway/src/services/skill-service.ts`

---

## 1. 表结构总结

### t_dsh_skills (主表)

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | CHAR(36) PK | UUID |
| `tenant_id` | CHAR(36) FK | 所属租户 |
| `creator_id` | CHAR(36) FK | 创建者 |
| `name` | VARCHAR(128) | 展示名称(非 runtime name) |
| `slug` | VARCHAR(128) | 用于 DSH skill name(当前为非严格 kebab-case) |
| `description` | TEXT | 描述 |
| `prompt` | TEXT | **Skill body/content(纯文本,MD)** |
| `tools` | JSON | 工具白名单 |
| `visibility` | VARCHAR(20) | `private` / `tenant` / `public` |
| `status` | VARCHAR(20) | `draft` / `pending_review` / `published` / `rejected` / `suspended` / `deprecated` |
| `latest_version` | VARCHAR(32) | 当前版本号 |
| `category` | VARCHAR(64) | 分类 |

### t_dsh_skill_versions (版本)

| 列 | 类型 | 说明 |
|----|------|------|
| `prompt` | TEXT | 版本快照的 body |
| `tools` | JSON | 版本快照的工具白名单 |

### t_dsh_skill_installations (安装记录)

| 列 | 类型 | 说明 |
|----|------|------|
| `user_id` | CHAR(36) | 安装者 |
| `tenant_id` | CHAR(36) | 安装者租户 |
| `skill_id` | CHAR(36) FK | 关联 skill |
| `version` | VARCHAR(32) | 安装时的版本(当前=latest) |
| `enabled` | TINYINT(1) | 是否启用 |

---

## 2. 10 个审计问题

### Q1: 哪个字段是 Runtime skill name？

**→ `slug` 列。**

当前 create 时由 service 层 slugify 生成:

```ts
const base = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const slug = base === '' ? `skill-${randomUUID().slice(0, 8)}` : base
```

不保证严格 kebab-case(不处理连续 `-`,不处理首尾 `-`)。

**结论:已有 `slug` 字段,但约束不严格。** 当前数据经实测满足 kebab-case;`listProjectableInstalled` 返回的 slug 经 `SKILL_NAME_RE` 校验,不合法的不进入投影。

### Q2: 是否满足 kebab-case？

**部分满足。** slugify 有边界问题(空 slug → UUID fallback ok;连续 `-` 可能产生 `--`)。Projection builder 有 `SKILL_NAME_RE` 过滤。

### Q3: description 从哪里来？

**→ `t_dsh_skills.description` 列。** 用户创建时可选传递;为空时 projection reader 回退为 `name`。

### Q4: content/body 从哪里来？

**→ `t_dsh_skills.prompt` 列。** 所有 published skill 必须有非空 prompt,否则被 projection builder 排除。

### Q5: publish 后实际使用哪个版本？

**→ `t_dsh_skills.latest_version` + 当前 prompt。** 暂无按版本固定安装的语义;install 记录写入时的 `version` = 当时的 `latest_version`。

### Q6: install 是 user 级、tenant 级还是 workspace 级？

**→ user 级。** `t_dsh_skill_installations` 按 `user_id` 隔离。Projection 按 `user_id` 查询 `listProjectableInstalled`。

### Q7: 是否有 enable/disable？

**→ 有(`t_dsh_skill_installations.enabled`)。** 当前 uninstall = DELETE row;install = INSERT/ON DUPLICATE UPDATE `enabled=1`。支持 future soft-disable。

### Q8: invocation policy 是否已有字段？

**→ 无。** 当前固定映射为 `{ modelInvocable: true, userInvocable: true }`;在 ADR-0002 记录。

### Q9: installed skill 是否一定有可加载 body？

**→ 不一定。** 安装时记录版本但 prompt 可能为空;Projection builder 排除 `prompt IS NULL` 或 `prompt = ''` 的记录(结构化 warning,不 crash)。

### Q10: publisher 更新后,已安装用户应该如何获得新版本？

**→ 当前模型:install 记录 `version` 为安装时的 `latest_version`。**
publish → `latest_version` 更新 → `rebuildProjectionsForSkill()` 刷新所有安装者(包括 version 未更新)。Projection 总是读当前 `t_dsh_skills.prompt`。

---

## 3. 安全边界

- `listProjectableInstalled` 在 SQL 层按 `user_id` 过滤,不在 JS filter
- tenant + owner 可见性在 `findById` SQL 中: `visibility = 'public' OR (visibility = 'tenant' AND tenant_id = ?) OR creator_id = ?`
- 投影路径由服务端 `tenantId` + `userId` 生成(UUID 校验),不接受请求参数

---

## 4. 现有路由

| method | path | 说明 |
|--------|------|------|
| GET | `/api/skills` | 搜索 |
| GET | `/api/skills/installed` | 已安装列表 |
| GET | `/api/skills/runtime-status` | (新增)投影状态 |
| GET | `/api/skills/:id` | 详情 |
| POST | `/api/skills` | 创建 |
| PATCH | `/api/skills/:id` | 更新 |
| POST | `/api/skills/:id/publish` | 发布 |
| POST | `/api/skills/:id/install` | 安装 |
| DELETE | `/api/skills/:id/install` | 卸载 |

---

## 5. 结论

数据模型满足 Phase 04 要求:
- ✅ 有 `slug`(runtime name)字段
- ✅ 有 `prompt`(body/content)字段
- ✅ 安装记录按 `user_id` 隔离
- ✅ tenant/owner 在 SQL 层过滤
- ⚠️ slugify 需加强 kebab-case 约束(已由 projection 层过滤兜底)