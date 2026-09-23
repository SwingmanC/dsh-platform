# Phase 01 — Harness Version Compatibility

> 审计日期:2026-09-16

---

## 1. 版本现状

| 维度 | 版本 | 说明 |
|---|---|---|
| 设计文档基准 | `0.1.2-rc.1` | 两篇设计文档均以此版本撰写 |
| peerDependencies | `0.1.2-rc.1` | sdk-driver 锁定的 peer |
| 实际安装 dsh | `0.1.1-rc.2` | README 标注,config.ts 内 DSH_VERSION |
| dsh-bridge 依赖 | `0.1.1-rc.2` | 全部 @deepseek-ai/ 依赖均为此版本 |
| dev preview 声明 | 官方 README | "THERE WILL BE COMPATIBILITY-BREAKING CHANGES" |

---

## 2. 已知 API 差异(0.1.1-rc.2 vs 0.1.2-rc.1)

| 差异项 | 0.1.1-rc.2 | 0.1.2-rc.1(设计预期) | 影响 |
|---|---|---|---|
| launch token | 无 | 应存在 | 设计 §3.2 无法实现;当前无 token 交换 |
| Web UI 路径 | 根绝对路径(/assets,/api) | 假设可挂子路径(/app/) | 改用专属 authority 路由 |
| Host 围栏 | --trusted-host | --trusted-host | 工作方式一致 |
| SDK profile | 确认存在 | 确认存在 | 一致,由 sdk-driver 接入 |

---

## 3. 兼容矩阵

| 组件/API | 本仓库版本 | 依赖的 Harness API | 0.1.1-rc.2 兼容? | 0.1.2-rc.1 兼容? | 建议 |
|---|---|---|---|---|---|
| `@dsh-platform/sdk-driver` | 0.1.0 | `dsh-sdk-client` (create/prompt/follow/resume) | 需确认 | 预期兼容 | 保持 0.1.2-rc.1 peer,待 SDK 接入时验证 |
| `@dsh-platform/dsh-bridge` | 0.1.0 | `cordis`, `dsh-api-remotes`, `dsh-client-ui-*` | ✅ 当前依赖即是 | 需验证 | 随 Harness 升级同步更新 |
| `dsh web` 启动参数 | — | `--no-open --host --port --trusted-host` | ✅ | 预期一致 | 无 break |
| `dsh --profile web` | — | web profile | ✅ | 预期一致 | 无 break |
| `dsh --patch` | — | profile patch YAML | ✅ | 预期一致 | 无 break |
| `dsh --profile sdk` | — | SDK profile | 需 PoC 验证 | 预期兼容 | P0 验证项 |

---

## 4. 升级建议

**结论:不建议立即升级。**

理由:

1. **实际安装为 0.1.1-rc.2**。设计文档按 0.1.2-rc.1 撰写,但当前代码已按 0.1.1-rc.2 的实际行为适配(专属 authority 路由,无 launch token)。
2. **sdk-driver 尚未接入**:peerDependencies 锁 0.1.2-rc.1 是为未来 SDK 接入准备,当前无运行时依赖。
3. **dsh-bridge 依赖锁 0.1.1-rc.2**:全部 @deepseek-ai/dsh-* 包均为此版本,与当前安装一致。
4. **dev preview 无兼容承诺**:升级可能在后续阶段带来 break,当前无足够测试覆盖来保障安全升级。

**保留 0.1.2-rc.1 peer 声明**作为目标版本,但生产运行继续使用 0.1.1-rc.2。在进入 Phase 03(Memory)或 Phase 04(Skill)前,需要:
- 先 PoC 验证 SDK profile 在新版本上的行为
- 建立兼容矩阵测试
- 确认 0.1.2-rc.1 的 launch token 行为

---

## 5. 官方文档阅读状态

| 文档 | URL | 状态 | 关键发现 |
|---|---|---|---|
| 官方仓库 AGENTS.md | https://github.com/deepseek-ai/deepseek-harness/blob/master/AGENTS.md | ✅ 已读 | "Plugins, not loop changes", "Model-visible ⟺ logged", ESM强制, 注册即effect |
| packages AGENTS.md | https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/AGENTS.md | ✅ 已读 | "ctx.get(name)"用于可选服务, 产品可见插件需REAL composition test, 插件导出规则 |
| SAFETY.zh.md | https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.zh.md | ✅ 已读 | 实验性软件, 沙箱≠完整隔离, "不要把Harness当作不可信workload唯一安全控制" |
| Plugin Tutorial | https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.zh.md | ✅ 已读 | 插件形态(函数/对象/类), inject声明依赖, ctx.effect自动清理 |
| Skills subsystem | https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/skills.zh.md | ✅ 已读 | ctx.skills分层注册表, SkillProvider接口, catalog/snapshot/get, 本地发现优先级 |
| MCP Client | https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.zh.md | ✅ 已读 | serverName namespace, stdio/streamable-http传输, 重连策略, 工具命名mcp__\<serverName\>__\<tool\> |