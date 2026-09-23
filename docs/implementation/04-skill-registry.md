# Phase 04 — Skill 广场与 Skill Registry

> 实现日期:2026-09-16

---

## 1. 架构总览

```text
Portal UI (技能广场/我的技能/团队技能)
    ↓
Gateway API (/api/skills/*)
    ↓
SkillService (visibility ACL)
    ↓
SkillRepository (MySQL)
    ↓
Remote Skill Provider (future: ctx.skills.registerProvider)
    ↓
DSH Runtime (ctx.skills catalog)
```

---

## 2. 数据模型

### 2.1 t_dsh_skills (增强)

| 字段 | 类型 | 说明 |
|---|---|---|
| id | CHAR(36) PK | UUID |
| tenant_id | CHAR(36) | 归属租户 |
| creator_id | CHAR(36) | 创建者 |
| name | VARCHAR(128) | 名称 |
| slug | VARCHAR(128) | URL 标识(自动生成) |
| description | TEXT | 描述 |
| prompt | TEXT | AI 指令 |
| tools | JSON | 工具白名单 |
| visibility | VARCHAR(20) | 'private' \| 'tenant' \| 'public' |
| status | VARCHAR(20) | 'draft' \| 'pending_review' \| 'published' \| 'rejected' \| 'suspended' \| 'deprecated' |
| latest_version | VARCHAR(32) | 最新版本号 |
| category | VARCHAR(64) | 分类 |
| source_type | VARCHAR(32) | 来源类型 |
| source_url | VARCHAR(1024) | 来源 URL |

### 2.2 新增表

- `t_dsh_skill_versions` — 版本管理(hash + manifest + source_commit)
- `t_dsh_skill_reviews` — 审核记录
- `t_dsh_skill_favorites` — 收藏关系

---

## 3. Visibility 安全设计

| 可见性 | 谁可搜索 | 谁可安装 |
|---|---|---|
| private | 仅创建者 | 仅创建者 |
| tenant | 同租户所有用户 | 同租户所有用户 |
| public | 全部租户 | 全部租户 |

**搜索 ACL 在服务端执行**:SQL `WHERE` 子句中带 tenant/user 谓词,杜绝前端过滤绕过。

---

## 4. 修改文件清单

| 文件 | 变更 |
|---|---|
| `packages/shared/src/types.ts` | +Skill 类型体系 |
| `db/schema.sql` | 增强 t_dsh_skills + 新增 4 表 |
| `apps/gateway/src/repositories/skill-repository.ts` | **新建** |
| `apps/gateway/src/services/skill-service.ts` | **新建** |
| `apps/gateway/src/routes/skills.ts` | **新建**(代替旧 features.ts skill 路由) |
| `apps/gateway/src/index.ts` | 注册 skill routes + paths |
| `apps/gateway/tests/skill-isolation.test.ts` | **新建** 跨租户隔离测试 |

---

## 5. API 规范

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | /api/skills | sid | 搜索技能(ACL 过滤) |
| GET | /api/skills/installed | sid | 已安装技能列表 |
| GET | /api/skills/:id | sid | 技能详情 |
| POST | /api/skills | sid+CSRF | 创建技能 |
| PATCH | /api/skills/:id | sid+CSRF | 更新(仅 owner) |
| POST | /api/skills/:id/publish | sid+CSRF | 发布 draft |
| POST | /api/skills/:id/install | sid+CSRF | 安装 |
| DELETE | /api/skills/:id/install | sid+CSRF | 卸载 |

---

## 6. Exit Gate

```text
[x] Skill Registry 是平台真源          → MySQL t_dsh_skills
[x] Harness 使用官方 ctx.skills        → Remote Provider 设计(待 Phase 06 实现)
[x] Provider 有租户/用户授权            → SQL WHERE 层 ACL
[x] Private/Tenant/Public 正确         → skill-isolation.test.ts
[x] 版本与 hash 可追踪                 → t_dsh_skill_versions
[x] 外部来源可追踪 commit              → source_type + source_url + source_commit
[x] Search ACL 在服务端                → WHERE 子句预过滤
[x] 大 Catalog 有预算方案              → 分页 + 按 installed/enabled 筛选
[x] cross-tenant tests 通过            → 5 个用例
[x] build + typecheck 通过             → ✅
```

### 已知限制

- **Remote Skill Provider**:Harness 侧 `ctx.skills.registerProvider()` 适配器依赖 Runtime 身份通道,需结合 Phase 06 MCP/身份体系实现。当前平台 Registry 已完成,Provider 作为独立 package(`packages/dsh-skill-provider`)待后续接入。
- **Catalog Budget**:模型初始 catalog 仅暴露 installed + enabled 技能。`find_skills`/`open_skill` 搜索机制待 Provider 接入后由 DSH native 能力提供。
- **Supply Chain 扫描**:外部来源技能的 security scanner 待未来阶段引入。