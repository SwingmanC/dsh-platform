# 00-Root-Cause-Reboot — 首条消息延迟诊断（基于 08A 实测证据）

> 日期：2026-09-22
> 依据：Phase 08A 多轮 Gate 的真实运行数据（rpcId 级 trace、gateway.log、探针计时）
> 性质：根因重启分析 —— 不沿用任何旧假设，所有结论附实测证据或验证方法

---

## 0. 已掌握的实测数据（本会话真实测量，非估算）

| 链路段 | 实测值 | 证据来源 |
|---|---|---|
| Platform login（argon2 验证） | ~50ms | gateway.log req 响应时间 |
| 首次进入 :8080 → ensureRuntime **冷启动 dsh runtime** | **~10-15s** | auth-smoke/ws08a 探针多次观测；supervisor 30s 超时设计佐证 |
| launch-token bootstrap（GET / → 303 交换） | ~0.1-0.3s | 03E2A 探针（bootstrap status=303） |
| UI shell 加载（46 个 client.js 插件 bundle + boot） | ~2-5s | gateway.log 一次性插件 roster；browser 轮询「技能广场」出现 |
| workspace provisioning（mkdir + DB 行） | <50ms | ensureDefaultWorkspace 幂等实现 |
| session/create（含 preset standing mount + 持久化 + attach） | **657-690ms** | rpcId=d1d909c8-536a-41fd-8632-77ca389009d8 实测（HEADERS 686ms / EXIT 0） |
| session/list | 15-60ms | 实测（raw-rpc） |
| skill / knowledge / memory 投影重建（spawn 前串行 await） | 未单独计时 | supervisor.ts L311-328 串行结构 |
| 模型目录默认 reasoning effort | **High** | /api/modelCatalog RPC 实测（defaultEffort:"high"） |
| LLM 首 token（TTFB） | **未测量** | 无任何 instrumentation |
| RPC dispatcher→handler→response 全链 | 657ms（含全部业务） | 03E2A boundary trace |

---

## 1. 当前架构假设问题

### A1「workspace provisioning 导致卡顿」— **已证伪**
实测 create 全链（含 workspace 解析、session 持久化、attach）<700ms，provisioning 本身 <50ms 且幂等。
继续优化 provisioning 是沉没成本谬误。

### A2「session 初始化在用户关键路径」— 部分错误
DSH UI 的 `watchNavigation` 在页面加载时**自动** connectWorkspace（connect → sessions.create({workspaceId})），
空白会话在用户打字之前就已创建。真正关键路径不在 session 创建。

### A3「初始化步骤越多越慢」— 不完整
skill→knowledge→memory 三个投影在 spawnRuntime 中**串行 await**，直接叠加进每一次 runtime 启动，
从未被单独计时 —— 属于未被观测的隐藏成本。

### A4「E2E PASS = 体验 OK」— 正是本任务禁止的盲区
Phase 08 全部 Gate 证明的是功能闭环，从未测量 send hello → first token。

### A5（新发现）「响应路径存在 hang」— **已排除**
03E2A 实测 690ms 端到端成功（HEADERS/BODY/PARSED/EXIT 0 + RESPONSE_FINISH）；
此前"卡住"样本全部为工具中断/前台静默伪象（03E2B 复盘，CLASSIFICATION=B）。

---

## 2. 卡顿来源假设排序（假设 — 证据 — 验证，不给结论）

| # | 假设 | 现有证据 | 验证方法 |
|---|---|---|---|
| **H1** | per-user runtime 冷启动（10-15s）在用户关键路径：首次导航才 spawn | ensureRuntime 多次观测；无预热机制；spawn 前还有串行投影 | supervisor 分段计时日志（T_projection/T_patch/T_spawn/T_ready）；浏览器 network 瀑布图 |
| **H2** | UI 插件 bundle 过重（46 个 client 模块一次性加载） | gateway.log 完整 roster | performance.getEntriesByType('resource') 按 bundle 汇总 |
| **H3** | 模型默认 reasoning effort=High 拖慢首 token | modelCatalog defaultEffort=high | 同 prompt effort=off vs high 各 3 次 TTFB 对比 |
| **H5** | 三投影串行 await 叠加进 spawn（归入 H1 计时） | supervisor 源码串行结构 | 分段计时后决定 `Promise.all` 并行化 |
| H4 | 首次 create 的 preset standing mount 一次性成本 | 657ms 已含 mount（一次性，之后复用） | 冷/热 create 对比 |
| H6 | 首 prompt 的 title-LLM 干扰流式 | dsh-session-title-first-prompt-llm 存在 | 首 token 时间 ± title 开关对比 |
| ~~H7~~ | ~~响应写路径 hang~~ | **已排除**（03E2A 690ms 全链贯通；此前为工具中断伪象 03E2B=B） | — |

---

## 3. 新架构建议（同步 / 异步 / 懒加载划分）

```
用户关键路径（目标 <5s）：
  login（~50ms）
  → 登录成功即后台预热 runtime（不等到首次导航）          [异步]
  → shell 渲染 → composer 立即可用                        [同步，唯一硬需求]
  → send hello → LLM 流式首 token                         [同步]
  → 会话由后台 auto-connect 创建（已实现，~0.7s）           [异步]

后台路径（允许慢，不得阻塞用户）：
  workspace provisioning（<50ms，保持现状）
  skill / knowledge / memory 投影（并行化或 spawn 后重建）  [异步]
  MCP rows / 插件发现 / 会话标题 LLM                        [异步/懒]
```

原则：**composer 可用 ≠ 全部能力就绪**。复杂能力在后台逐步加载，加载完成后自然出现。

---

## 4. 下一步最小修改建议（禁止大规模重构）

1. **Instrumentation**（只加日志）：
   - supervisor：spawn 分段计时 `T_projection / T_patch / T_spawn / T_ready`
   - proxy preHandler：记录 T2（backend receive）与 ensureRuntime 命中/等待
   - prompt 完成：记录 T7（LLM request）→ T8（first token）
2. **Feature flags**：
   - `PLATFORM_SKIP_PROJECTIONS=1`（Experiment 0 裸链路）
   - `PLATFORM_RUNTIME_PREWARM=1`（登录后预热 runtime）
3. **一行级优化**：三投影 `Promise.all` 并行（预期从 H1 扣减 1-3s）
4. **禁止**：新增 provisioning 状态机、新 gate、新回滚层、用更多初始化步骤解决未知问题

---

## 5. 实验计划

| 实验 | 内容 | 判定量 |
|---|---|---|
| **Exp0 裸链路** | stripped headless dsh + 直接 prompt（无 workspace/memory/skill/MCP/projection） | 冷 spawn 基线 + TTFB 基线（验证 H1/H3 占比） |
| Exp1 +workspace | 加 provisioning | 预期 +<100ms → 保留 |
| Exp2 +memory | 加 memory 投影 | 若投影进入 critical path → 移后台 |
| Exp3 +skill | 加 skill 投影 | 同上 |
| Exp4 +MCP | 加 connector rows | spawn 前 patch 渲染 vs spawn 后热插，按实测决定 |

每步记录：新增组件 / 增加延迟 / 是否 critical path / 最终决定（同步·异步·懒）。

---

## 6. 一句话结论

本会话实测已证明 workspace/session 链路只需 **<0.8s**；
真正的首句卡顿几乎确定分布在三段：
**runtime 冷启动（10-15s）→ UI/插件启动（2-5s）→ 模型 High reasoning 首 token（未测）**。
下一步先做 Exp0 + 三处计时埋点，用数据确认后再动架构。

---

## 附：关键证据索引

- session/create 端到端成功：rpcId=d1d909c8-536a-41fd-8632-77ca389009d8（HEADERS 686ms / EXIT 0 / SESSION_PERSISTENCE=PASS）
- 03E2B 复盘：REVIEWED_FAILURE_CLASSIFICATION=B_TOOL_INTERRUPTION_ARTIFACT；VENDOR_PATCH_JUSTIFIED_NOW=false
- preset 迁移：agent-presets.default code→ptc（平台 preflight，supervisor 内）
- 运行器资格：run-bounded 3/3 timeout PASS；run-visible-captured heartbeat+capture PASS
