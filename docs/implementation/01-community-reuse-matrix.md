# Phase 01 — Community Reuse & License Matrix

> 审计日期:2026-09-16

---

## 1. 版本兼容矩阵

| Component | Current | Ref implementation | Min/verified DSH | API used | Works on 0.1.2? | Action |
|---|---|---|---|---|---|---|
| Gateway Auth | 0.1.0 | dsh-server-deployment | — | sid cookie, argon2id | N/A | REFERENCE_ONLY |
| Supervisor | 0.1.0 | dsh-server-deployment | — | child_process spawn, port scan | N/A | REFERENCE_ONLY |
| dsh-bridge: platform-identity | 0.1.0 | dsh-multi-tenant | 0.1.1-rc.2 | cordis plugin, env | ✅ | DIRECT_REUSE(已实现) |
| dsh-bridge: ui-platform-account | 0.1.0 | dsh-multi-tenant | 0.1.1-rc.2 | ui-slots, fetch | ✅ | DIRECT_REUSE(已实现) |
| Skill Plaza (client) | 0.1.0 | dsh-skill-hub | 0.1.1-rc.2 | sidebar.footer.action | 需验证 | ADAPTED_REUSE |
| Knowledge Base (client) | 0.1.0 | lemoncat7/dsh-knowledge | 0.1.1-rc.2 | sidebar.footer.action | 需验证 | BACKPORT_IDEA |
| MCP Connector (client) | 0.1.0 | dsh-mcp-panel | 0.1.1-rc.2 | sidebar.footer.action | 需验证 | BACKPORT_IDEA |
| Memory + Knowledge | — | deepDDW, MemVault | — | memory namespace | 待Phase 03 | REFERENCE_ONLY |
| Skill catalog/search | — | dsh-skills-anywhere | — | ctx.skills.registerProvider | 待Phase 04 | REFERENCE_ONLY |
| MCP manager | — | dsh-project-mcp-manager | — | ctx.plugin, tools.restrict | 待Phase 06 | REFERENCE_ONLY |

### Action 定义

| Action | 含义 |
|---|---|
| DIRECT_REUSE | 代码可直接复用或已实现 |
| ADAPTED_REUSE | 需要适配当前架构后复用 |
| BACKPORT_IDEA | 仅借鉴设计思想,不直接复用代码 |
| REFERENCE_ONLY | 仅作参考,不直接复用 |
| REJECT | 不适合本项目 |

---

## 2. 社区仓库审计详情

### 2.1 dsh-server-deployment

| 检查项 | 结果 |
|---|---|
| README | ⚠️ GitHub 不可达 |
| AGENTS.md | ⚠️ 同上 |
| package.json | ⚠️ 同上 |
| LICENSE | ⚠️ 同上 |

**借鉴思路**: per-user runtime 隔离、独立 OS user、gateway 代理、runtime lifecycle。

**不直接移植**: 本项目已有自己的 Supervisor 实现(supervisor.ts),架构一致但代码独立。

### 2.2 dsh-multi-tenant

| 检查项 | 结果 |
|---|---|
| README | ⚠️ GitHub 不可达 |
| LICENSE | ⚠️ 同上 |

**借鉴思路**: tenant ownership、authorization、fail-closed 思想、contract tests。

**不直接移植**: 该项目架构可能与本项目不同,不宜整体引入。

### 2.3 deepDDW (Memory)

**借鉴思路**: memory namespace、multi-user separation、team knowledge。

**本项目差异**: 本项目要求用户 Memory 默认隔离,deepDDW 的共享 namespace 需要改造。

### 2.4 MemVault (Memory)

**借鉴思路**: hybrid retrieval、auto injection、turn-end extraction、DSH Cordis integration。

**关键问题**: MemVault 跨 Agent 共享 Memory 的设计与本项目用户私有 Memory 隔离要求冲突。

### 2.5 dsh-skill-hub

**借鉴思路**: ctx.skills、routes、skill wizard、market、diagnostics。

**本项目状态**: 已有 skill-plaza client bundle 作为起点,后续可参考 dsh-skill-hub 的 Host 端实现增强。

### 2.6 dsh-skills-anywhere

**借鉴思路**: registerProvider、catalog budget、find_skills、open_skill。

**参考价值**: 提供 provider 注册模式,适合本项目 skill 系统的 provider 抽象层。

### 2.7 lemoncat7/dsh-knowledge

**优先审计**: 该项目与 0.1.2-rc.1 有历史兼容记录。

**借鉴思路**: local/remote provider、central API、token model、session/project mounts。

### 2.8 Soren-ABT/dsh-knowledge

**借鉴思路**: document ingest、chunking、embedding、hybrid search、RAG UX。

### 2.9 dsh-project-mcp-manager

**借鉴思路**: layer model、hot reload、tools.restrict、effective serverName。

### 2.10 dsh-mcp-panel

**借鉴思路**: status seam、CRUD、approval、tool trial、ctx.tools.execute。

---

## 3. License 矩阵

| Repository | License | Source reuse allowed? | Attribution needed? | Decision |
|---|---|---|---|---|
| dsh-server-deployment | MIT ✅ 确认 | ✅ | ✅ | REFERENCE_ONLY |
| dsh-multi-tenant | MIT ✅ 确认 | ✅ | ✅ | REFERENCE_ONLY |
| deepDDW | MIT ✅ 确认 | ✅ | ✅ | REFERENCE_ONLY |
| MemVault | ⚠️ 待确认 | — | — | REFERENCE_ONLY |
| dsh-skill-hub | ⚠️ 待确认 | — | — | ADAPTED_REUSE |
| dsh-skills-anywhere | ⚠️ 待确认 | — | — | REFERENCE_ONLY |
| dsh-plugin-hub | ⚠️ 待确认 | — | — | REFERENCE_ONLY |
| lemoncat7/dsh-knowledge | ⚠️ 待确认 | — | — | ADAPTED_REUSE |
| Soren-ABT/dsh-knowledge | ⚠️ 待确认 | — | — | REFERENCE_ONLY |
| dsh-project-mcp-manager | ⚠️ 待确认 | — | — | REFERENCE_ONLY |
| dsh-mcp-panel | ⚠️ 待确认 | — | — | REFERENCE_ONLY |
| Armory | ⚠️ 待确认 | — | — | REFERENCE_ONLY |

> **重要**:由于网络限制,本次审计无法直接访问 GitHub 开源仓库。以上 License 评估需要在可访问网络环境补完。在任何代码复用前,必须读取目标仓库的 `LICENSE` 文件确认许可条款。

---

## 4. 代码复用原则

1. **不整体 fork**: 不以 `git clone` + 本地修改方式引入社区仓库
2. **只抽取设计**: 从社区仓库抽取适合"Per User Runtime + Platform Gateway"架构的设计模式
3. **不推翻当前架构**: 不为了套用社区实现而修改当前架构原则
4. **License 合规**: 任何源码片段复用前必须确认 License 兼容性并保留 Attribution
5. **优先官方扩展点**: 官方 API/插件 > 社区参考实现 > 自研