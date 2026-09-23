# QwenPaw 与现有平台功能差距分析(静态审计)

> 日期:2026-09-23
> 方法:纯静态源码阅读,未启动服务、未执行测试、未修改业务代码(任务 01 纪律)。
> 对比对象:
> - **QwenPaw Demo**:`F:\工作\dsh-platform\qwen-java`(Java 21 + Spring Boot 3 + AgentScope-Java + Vue 3)
> - **本平台**:`F:\工作\dsh-platform\dsh-platform`(Fastify 网关 + MySQL + 每用户 dsh 0.1.5-rc.2 运行时)
> 引用约定:`文件:行号`;标注 **UNVERIFIED** 的行号来自探索代理报告,本次未逐一亲验。

---

## 0. 结论摘要

| 域 | 结论 |
|---|---|
| 知识库 | **差距最大**。QwenPaw 是完整 RAG(Tika 解析/语义分块/pgvector 向量检索/溯源快照);我们是 MySQL `LIKE` 关键词搜块。但 DDL 已预留 `embedding BLOB`、状态机列,迁移成本低。 |
| MCP | 我们的门禁/加密/投影治理**强于** Demo;缺连接测试、工具级启停、冲突校验、模板市场、部分安全细节。 |
| Skill | 双方机制不同(我们 DB+provider 投影,Demo 文件即技能),治理语义(撤回锁定/zip 导入)可借鉴;注意与 DSH 原生文件技能的**重复开发风险**。 |
| Memory | 机制相当(bounded recall vs 加权检索);会话压缩 DSH 原生已有,**不做**。 |

---

## 1. 知识库 / RAG

### 1.1 对比表

| 能力点 | QwenPaw 实现 | 本平台现状 | DSH 原生 | 定性 |
|---|---|---|---|---|
| 文件格式 | txt/md/pdf/docx,≤50MB(`rag/KnowledgeService.java:41,144`) | knowledge-storage.ts 存储;解析格式范围 UNVERIFIED | 无 | 补齐解析器 |
| 去重 | SHA-256 同库去重(`KnowledgeService.java:158-159,183`) | `document_versions.content_hash` 列存在(schema.sql:355),上传时是否校验 UNVERIFIED | 无 | 小改 |
| 解析 | Apache Tika AutoDetectParser(`KnowledgeService.java:302-308`,UNVERIFIED) | ingestion.ts 自研抽取(格式 UNVERIFIED) | 无 | 评估引入 Tika 替代品或增强 JS 侧解析 |
| 分块 | 段落聚合,目标 ~700 token,重叠 100,超长二分(`rag/TextChunker.java:25-51`,UNVERIFIED) | 定长 2048 字符 + 段落切分(`ingestion.ts:4,25,47`) | 无 | **改** |
| 索引任务 | `rag_index_job` + FOR UPDATE SKIP LOCKED worker + 租约/重试(`KnowledgeService.java:229-300`,UNVERIFIED) | `t_dsh_knowledge_ingestion_jobs` 表已建(schema.sql:392-404),驱动方式(同步/异步)UNVERIFIED | 无 | **补状态机与重试** |
| 向量存储 | pgvector `vector(2048)` + HNSW(`V17__rag_knowledge_base.sql:71,83-84`,UNVERIFIED) | `chunks.embedding BLOB` 已预留但未用(schema.sql:371);搜索用 `content LIKE ?`(`knowledge-repository.ts:120`) | 无 | **核心缺口** |
| 检索 | halfvec 余弦 + score≥0.55 + topK=6 + ≤6000 token(`rag/KnowledgeRetrievalService.java:40,57,73`) | LIKE 关键词匹配(`knowledge-repository.ts:116-123`) | 无 | **核心缺口** |
| 注入方式 | 对话链路自动检索注入 + `<retrieved_context>` 防注入包装 + `[S1]` 引用码(`ChatService.java:341-358`;`augment():84-99` 已验证) | `knowledge_search`/`knowledge_read` 工具式(cmcc-knowledge-runtime;`profile-patch.ts:18-19`) | 工具调用由 DSH 承担 | 机制不同,**可并存** |
| 溯源 | 命中快照落 `rag_answer_source` 供前端展示(UNVERIFIED) | 无 | 无 | 新表 |
| 重索引 | `index_version` 蓝绿(`KnowledgeService.java:178` 已验证写入) | `documents.current_version` 是文档版本,非索引版本 | 无 | 新增列 |
| Embedding 配置 | 平台级 DB 配置表 + key 加密 + hint 回显(`rag/EmbeddingConfigService.java`,UNVERIFIED) | 无(provider_credentials 表为 P2 BYOK 预留) | 无 | 新表 |

### 1.2 可复用与真实缺口

- **可直接复用(我们已具备)**:ACL 预过滤投影(`knowledge-repository.ts:136-156`,检索前已按 mount+可见性过滤)、挂载模型、`knowledge_search` 工具通道(向量检索替换 LIKE 后 runtime 侧无感)、状态机列(`documents.status` schema.sql:341)。
- **真实缺口**:embedding 供应商配置、向量索引与检索、语义分块、索引任务编排、溯源快照。
- **重复开发风险**:QwenPaw 的"自动检索注入"走对话中间件;我们走 DSH 工具调用。**不必**为对齐 Demo 改成自动注入——工具式与 DSH 架构更契合,且 recall 注入机制已在 memory 域存在。

### 1.3 最小改动项(独立拆分)

| # | 项 | 改动范围 | 依赖 | 风险 |
|---|---|---|---|---|
| K1 | Embedding 配置表 + 连通性测试 | 新表 `t_dsh_rag_embedding_config`(加密 key 列复用 credential-store);REST + KnowledgePanel 表单 | 无 | 无 |
| K2 | 索引任务状态机 + 重试 | `ingestion.ts` 异步化:状态 pending→parsing→chunking→ready→failed;MySQL 8 支持 `FOR UPDATE SKIP LOCKED`;失败退避 | K1(embedding 前置于 embedding 阶段,但分块/解析可先行) | 长任务并发;`jobs` 表缺 lease 列需加列 |
| K3 | 语义分块 | `ingestion.ts:25` 重写:token 估算 + 段落聚合 + 重叠 | 无(独立于向量) | 旧 chunk 需重索引 |
| K4 | 向量存储与检索 | **决策点**:A) `hnswlsx2`(纯 WASM 进程内 + `var/kb-index/` 快照,零运维,推荐) B) sqlite-vec C) Postgres+pgvector(双库) D) MySQL 9。`chunks.embedding BLOB` 可存原始向量做重建源 | K1、K2 | 进程重启需重建/加载索引;多实例一致性(单网关场景可接受) |
| K5 | 溯源引用 | 新表 `t_dsh_knowledge_citations`;`knowledge_search` 返回带 `[Sn]` 引用码;注入文本防注入包装 | K4 | 面板展示需前端配合 |
| K6 | 蓝绿重索引 | chunks 加 `index_version`;新旧共存,新索引 READY 后删旧 | K4 | 存储翻倍(过渡期) |

---

## 2. MCP

### 2.1 对比表

| 能力点 | QwenPaw 实现 | 本平台现状 | DSH 原生 | 定性 |
|---|---|---|---|---|
| 配置模型 | `mcp_connections` 表:auth_type/secret_enc/hint/headers_json/enabled/locked/status/last_error(`domain/McpConnection.java:8-36`,UNVERIFIED) | `t_dsh_mcp_connectors`:auth_type/allowed_domains/last_test_at/risk_level 已有列(schema.sql:425-431);credential_ref 引用凭据表 | — | 列基本齐 |
| 连接测试 | create(DRAFT)→test(initialize+listTools)→setEnabled(`McpService.java:67,129,193`) | `last_test_at` 列预留但无测试实现(UNVERIFIED) | 连接由 runtime 内官方 client 承担 | **缺** |
| 工具级启停 | `McpToolPolicy`:tools/list 缓存 + per-tool enable(UNVERIFIED) | 无;授权即全量工具透传 | — | **缺** |
| 工具名冲突 | `ensureNoToolConflicts` 启用前置校验(`McpService.java:200,423` 已验证) | 无 | — | **缺** |
| 凭据安全 | AES-GCM-256;DTO 只回 hasSecret/hint;`safeError` 脱敏(`:479` 已验证) | AES-256-GCM credential-store + 环境变量名服务端生成(`supervisor.ts:177-190`);错误脱敏 UNVERIFIED | token 不出网关(架构既有) | 基本持平,补脱敏 |
| SSRF/注入防护 | 禁云元数据地址(`:462` 已验证 `169.254.169.254/metadata.google.internal`)、禁非 http(s)、header CRLF/authorization/host/cookie 校验(`:466-468`,UNVERIFIED) | origin 白名单 + loopback 开关(.env.example:69-72);元数据黑名单/header 校验无 | — | **补强** |
| 传输 | streamable-http + stdio(仅此二种) | 同;stdio 默认禁用(PLATFORM_MCP_ALLOW_STDIO) | `@deepseek-ai/dsh-mcp-client` 官方注入 | 持平 |
| 模板市场 | McpTemplate + 版本化 Release;用户安装只填 secret/env(UNVERIFIED) | scope='platform' connector 可近似;无模板版本化 | — | 可选,工作量偏大 |
| 运行时注册 | 失败隔离:单个 MCP 初始化失败仅告警(`McpRuntimeService.java:60-63`,UNVERIFIED) | `failOnStartupError` 渲染参数(`profile-patch.ts:68`)+ cmcc-mcp-observer ack 观测 | 官方 client 行为 | 基本持平 |
| 变更生效 | 写操作→`rebuildAll()` 重建 Agent(`AgentManager.java:403`,UNVERIFIED) | 投影/patch 仅 spawn 时构建(`supervisor.ts:361-374,411-414`);**运行中授权变更不生效** | patch 为启动语义 | **缺热应用** |

### 2.2 最小改动项

| # | 项 | 改动范围 | 依赖 | 风险 |
|---|---|---|---|---|
| M1 | 连接测试 + 工具预览 | 网关侧短连 client(复用 `@modelcontextprotocol/sdk`,mcp-fixture 已依赖);test=initialize+listTools 后即断开;结果写 `last_test_at`+tool_count | 无 | 网关侧发起出站连接需过 origin 白名单校验 |
| M2 | 工具级启停 + 冲突校验 | connectors 加 `tool_policy JSON`;授权前校验 serverName/工具名冲突;投影渲染时过滤 | M1(需要工具列表) | patch 行渲染逻辑变更 |
| M3 | 安全补强 | 元数据地址黑名单、header 校验(CRLF/authorization/host/cookie)、`safeError` 式脱敏(`routes/mcp.ts`,`mcp-service.ts`) | 无 | 低 |
| M4 | 授权变更热应用 | 变更事件 → `drainRuntime(userId)`;下次访问按新投影拉起(supervisor 既有能力) | 无 | 会中断当前会话;需前端提示或闲时 drain |
| M5 | 模板市场(可选) | 新表模板/发布;安装=模板实例+私有凭据 | M1/M2 | 工作量大,建议缓行 |

---

## 3. Skill

### 3.1 对比表

| 能力点 | QwenPaw 实现 | 本平台现状 | DSH 原生 | 定性 |
|---|---|---|---|---|
| 存储模型 | 文件即技能:`<workspace>/skills/<name>/SKILL.md`,frontmatter 含 owner_id/published/locked/installed_from/preload/tags(`agent/skill/SkillManager.java:170-175` frontmatter 写入已验证) | DB:`t_dsh_skills/versions/installations`;body=单段 prompt 文本(`skill-service.ts:15-25`;`skill-projection.ts:12` 注释) | `dsh-skill`/`dsh-skill-filesystem`/`dsh-tool-skill`/`dsh-client-ui-skill` 原生文件技能体系(.tools 包列表) | 模型不同,**勿盲目对齐** |
| 启用/禁用 | 禁用名单 `skills-config.json`;locked 不可启用(`SkillManager.java:353,378` 已验证) | installations.enabled 列(schema.sql:271) | — | 持平 |
| 版本/发布 | markPublished 打标(`:381-386` 已验证);无版本表 | versions 表 + publish 流程(`skill-service.ts:28-29`) | — | 我们更强 |
| 撤回锁定 | 管理员删池技能→工作区副本 `locked`+禁用(`SkillManager.java:406-417`,UNVERIFIED) | 下架(publish 撤回)后已安装副本不受影响 | — | **缺** |
| 池/市场 | 企业池:发布剥离私有元数据 + 批量下发 + zip 导入预检 previewOnly(`agent/skill/SkillPoolManager.java`、`SkillZipHelper.java`,UNVERIFIED) | visibility private/tenant/public + 安装/卸载 | — | 部分:可见性已有 |
| 注入 | SkillBox 仅注册 name+description,正文 `load_skill` 按需(`QwenPawAgentFactory.java:114-121`,UNVERIFIED) | provider 投影(`ctx.skills.registerProvider`,`skill-projection.ts:7`);渐进式披露行为 UNVERIFIED | DSH 原生 skill 即渐进式 | 核对即可 |
| 脚本执行 | run_skill_script + 路径越界检查(`SkillScriptTool.java:51-79`,UNVERIFIED) | 无脚本技能 | DSH 原生 bash 工具可覆盖 | 暂缓 |

### 3.2 最小改动项

| # | 项 | 改动范围 | 依赖 | 风险 |
|---|---|---|---|---|
| S1 | SKILL.md 结构化 body | `t_dsh_skill_versions.body` 由纯 prompt 升级为 frontmatter+正文(或加 metadata JSON 列);投影按结构渲染;API 兼容旧 prompt | 无 | 投影格式需与 dsh 原生 skill 解析器核对(UNVERIFIED:dsh 对 provider 技能的字段要求) |
| S2 | 撤回锁定 | installations 加 `locked TINYINT(1)`;下架时批量置 locked+disabled;投影排除 locked | 无 | 低 |
| S3 | zip 导入预检 | 上传 zip → 解析清单 → 冲突列表 + 建议名 → 确认后 all-or-nothing 写入 | S1(包内为 SKILL.md 结构) | 中 |
| S4 | 渐进式披露核对 | 审计 `cmcc-skill-provider` 投影内容:确认仅 name+description 常驻,正文按需 | 无 | 仅核查 |

---

## 4. Memory

### 4.1 对比表

| 能力点 | QwenPaw 实现 | 本平台现状 | DSH 原生 | 定性 |
|---|---|---|---|---|
| 会话摘要压缩 | ContextCompactor→`chat_session.summary`(UNVERIFIED) | 无 | `dsh-compaction-basic`(原生会话压缩,.tools 包列表) | **不做**(重复) |
| 记忆存储 | Markdown 文件 frontmatter UUID.md(`agent/memory/MemoryManager.java:94-106` 已验证) | `t_dsh_memory_records` + promotions 表 | DSH 无 memory 包 | 我们更强(DB+审计) |
| 检索 | 关键词加权 score(title+100/tag+50/content+10,`MemoryManager.java:128` 调用已验证,权重 UNVERIFIED) | bounded recall 预算截断(supervisor env `PLATFORM_MEMORY_MAX_RECALL_*`) | — | 可借鉴加权 |
| 自动注入 | MemorySearchMiddleware 每轮一次(默认关,UNVERIFIED) | bounded recall 自动注入(cmcc-memory-runtime) | — | 持平 |
| 租户隔离 | 目录 per dept/user + fail-closed(`security/WorkspaceResolver.java:93`,UNVERIFIED) | TenantContext 仓库层过滤 + promote 角色校验(`memory-service.ts:69-87` 已验证) | 每用户独立 DSH_HOME | 我们更强 |
| 向量记忆 | 复用 RAG 向量层 | 无 | — | 依赖 K4,可后续 |

### 4.2 最小改动项

| # | 项 | 改动范围 | 依赖 | 风险 |
|---|---|---|---|---|
| E1 | 记忆加权检索 | memory-repository 搜索从简单匹配升级为字段加权排序 | 无 | 低 |
| E2 | 向量记忆检索(可选) | 复用 K4 基建,记忆内容入向量索引 | K4 | 中 |

---

## 5. 多租户授权与数据隔离核对

- **本平台**:所有仓储首参 `TenantContext`;越权返回 404;知识检索前 ACL 预过滤(`knowledge-repository.ts:136-156`);memory promote 有角色门禁(`memory-service.ts:73` member 不可提权)与审计落库;MCP 凭据按 connector 隔离、env 变量名服务端生成;runtime 投影目录按 `<tenantId>/<userId>` 分隔(`supervisor.ts:307-308,127-131`)。
- **QwenPaw**:部门/用户目录隔离(`d-{deptId}/u-{userId}`)+ owner_id 字段 + Spring `@PreAuthorize` RBAC;`_unknown` 兜底防串租户(UNVERIFIED)。
- **借鉴约束**:引入任何 Demo 机制时,**不得**采用"文件路径即授权"模式;一切资源访问必须经 TenantContext 仓储层,与平台 ACL 模型保持一致。

## 6. 与 workspace/session 的依赖

| 功能 | 现状依赖 | 说明 |
|---|---|---|
| 知识挂载 | 用户级:`t_dsh_knowledge_mounts` 实际只用 user 维度(`knowledge-repository.ts:125,146`);DDL 已预留 `mount_type('user'\|'session'\|'workspace')`+`mount_ref`(schema.sql:384-385) | 若做工作区级挂载,仅需服务层启用既有列,无迁移 |
| 技能安装 | 用户级安装→投影 per user→DSH 原生 skill UI 消费;**运行中投影热更新路径 UNVERIFIED**(spawn 时构建:`supervisor.ts:331`) | 与 M4 同一机制可解 |
| MCP 授权 | patch rows 仅 spawn 渲染(`supervisor.ts:361-374`)→ 变更生效依赖 runtime 重启 | M4 |
| memory recall | 每轮经 runtime→网关内部通道,无 workspace 依赖 | 无需改动 |

## 7. 数据库迁移需求汇总(均为增量,可幂等)

1. 新表:`t_dsh_rag_embedding_config`、`t_dsh_knowledge_citations`(K1/K5)
2. 加列:`t_dsh_knowledge_chunks.index_version`、`t_dsh_knowledge_ingestion_jobs.lease_expires_at/attempts`、`t_dsh_skill_installations.locked`、`t_dsh_mcp_connectors.tool_policy/secret_hint/last_error`
3. 注意:`db/schema.sql` 为 DROP+CREATE 幂等脚本,重跑会清数据;生产需改用增量 ALTER 脚本(迁移机制本身 UNVERIFIED:仓库内未见 migration 目录)。

## 8. 重复开发风险清单

| 风险 | 处置 |
|---|---|
| 会话摘要压缩 vs `dsh-compaction-basic` | 不做 |
| selectedSkill 单技能模式 vs DSH agent-presets/原生 skill UI | 不做 |
| 平台技能 provider vs DSH 原生文件技能双轨 | 边界:平台治理技能走 provider;用户工作区自建走原生;S1 对齐格式降低摩擦 |
| 网关自建 MCP 长连接管理 vs 官方 `dsh-mcp-client` | 仅允许网关侧**短连测试**(M1);运行时连接仍归官方 client |
| 自动检索注入 vs 工具式检索 | 保持工具式;不为对齐 Demo 改架构 |

## 9. 不确定项(UNVERIFIED)汇总

1. 我们 ingestion 的解析格式范围与同步/异步驱动方式(需读 `ingestion.ts` 全文与 `knowledge-storage.ts`)。
2. `cmcc-skill-provider` 渐进式披露行为与 dsh 对 provider 技能的字段要求(S1/S4 前置核查)。
3. QwenPaw 分块参数、worker 租约、rag_answer_source、McpToolPolicy 细节、MemoryManager 权重常量(仅代理报告,未亲验)。
4. 本仓库数据库迁移机制(是否存在增量 migration 流程)。
5. 运行中技能投影是否有热更新路径。

---

**按任务纪律,本审计到此为止;不自动进入开发,等待人工确认实施顺序。**
