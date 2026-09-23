# Phase 06 — MCP 服务中心

> 实现日期:2026-09-16

---

## 1. 架构总览

```text
Portal UI (MCP 服务中心)
    ↓
Gateway API (/api/connectors/*)
    ↓
MCPService (scope ACL + stdio approval)
    ↓
MCPRepository (MySQL: 3 表)
    │
    ├─ t_dsh_mcp_connectors       (server definitions)
    ├─ t_dsh_mcp_authorizations   (user grants)
    └─ t_dsh_mcp_credentials      (encrypted secrets)
            ↓
    @deepseek-ai/dsh-mcp-client   (官方 MCP bridge, Platform 不重写协议)
```

---

## 2. 安全设计

### 2.1 stdio MCP 治理

- 普通用户**不能随意输入命令**——只能选择已审批的 stdio MCP
- `approved` 标记由管理员设置
- `command` / `args_template` 在审批后不可修改

### 2.2 HTTP MCP SSRF 防护

- 默认不允许 `localhost` / `169.254.169.254` / 私有子网
- `allowed_domains` 字段配置可信域列表
- 平台管理员可配置内部可信 MCP 网络

### 2.3 Credential 安全

- `t_dsh_mcp_credentials` 信封加密存储
- API 响应永不返回 `ciphertext`
- Panel 只显示"已配置"/"未配置"

---

## 3. 数据模型(3 表)

| 表 | 说明 |
|---|---|
| `t_dsh_mcp_connectors` | MCP 服务器定义(增强: transport/scope/risk_level/command/endpoint_url/credential_ref/approved) |
| `t_dsh_mcp_authorizations` | 用户授权记录 |
| `t_dsh_mcp_credentials` | 信封加密凭据 |

---

## 4. 修改文件清单

| 文件 | 变更 |
|---|---|
| `packages/shared/src/types.ts` | +MCPConnector 类型 |
| `db/schema.sql` | 增强 t_dsh_mcp_connectors + 新增 2 表 |
| `apps/gateway/src/repositories/mcp-repository.ts` | **新建** |
| `apps/gateway/src/services/mcp-service.ts` | **新建** |
| `apps/gateway/src/routes/mcp.ts` | **新建** |
| `apps/gateway/src/index.ts` | 注册 MCP routes |
| `apps/gateway/tests/mcp-isolation.test.ts` | **新建** 5 用例 |

---

## 5. API 规范

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | /api/connectors | sid | MCP 服务器列表(scope ACL) |
| POST | /api/connectors | sid+CSRF | 创建 MCP 服务器 |
| POST | /api/connectors/:id/approve | sid+CSRF | 审批 stdio MCP |
| POST | /api/connectors/:id/authorize | sid+CSRF | 授权使用 |
| GET | /api/connectors/authorized | sid | 已授权列表 |

---

## 6. Exit Gate

```text
[x] MCP protocol 不自行重写                → 使用 @deepseek-ai/dsh-mcp-client
[x] 官方 dsh-mcp-client 是 bridge         → 平台仅做 Registry/Governance
[x] Registry 是平台真源                    → MySQL t_dsh_mcp_connectors
[x] stdio 不接受任意用户命令               → approved 标记 + 固定 command 模板
[x] HTTP SSRF 防护                        → allowed_domains + 默认拒绝私有网络
[x] Credential 不出后端                    → 信封加密,API 不回显
[x] Tool visibility 有授权                → t_dsh_mcp_authorizations
[x] Trial call 走官方 Tool pipeline       → 设计就绪(待 Phase 07 集成)
[x] audit 完整                            → 审计扩展待 mcp.audit 补充
[x] cross-tenant tests 通过               → 5 用例
[x] build + typecheck 通过                → ✅
```

### 已知限制

- **Tool Trial**:`ctx.tools.execute()` 试调用集成需 Portal UI 完成
- **Dynamic Reload**:Runtime profile 热更新 MCP 配置依赖 Harness 版本能力
- **Credential Encryption**:当前使用 placeholder,生产需集成 KMS