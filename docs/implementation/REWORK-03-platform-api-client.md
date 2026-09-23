# REWORK-03 — PlatformApiClient(平台 API 客户端层)

> 目的:把四个 Panel 与 Gateway REST endpoint 解耦;集中身份/CSRF/错误处理。
> 源:`packages/cmcc-platform-ui/src/client/platform-api.ts`

---

## 1. 职责与纪律

- 唯一出口:React 组件不直接 `fetch`;一律经 `PlatformApiClient`。
- **身份不可伪造**:client 输入只有 resource id 与 mutation payload;绝不传 `userId` / `tenantId` / `ownerId`。Gateway 从当前 authenticated principal 推导租户/用户/权限。
- 读(GET)不带 CSRF;写(POST/PATCH/DELETE)带 `x-csrf-token`(双提交 cookie)。
- 所有请求 `credentials: 'include'`(平台 sid cookie)。
- 错误归一为 `PlatformApiError { status, code }`;不暴露 stack/SQL/token。
- `fetchImpl` 可注入 → 单元测试无需网络/浏览器。

## 2. 覆盖的现有 endpoint(本阶段集中封装,不迁移 namespace)

| 域 | 方法 | Endpoint |
|---|---|---|
| Skill | listSkills | `GET /api/skills?q&visibility&category&status&limit&offset` |
| Skill | listInstalledSkills | `GET /api/skills/installed` |
| Skill | getSkill | `GET /api/skills/:id` |
| Skill | createSkill | `POST /api/skills` |
| Skill | publishSkill | `POST /api/skills/:id/publish` |
| Skill | installSkill | `POST /api/skills/:id/install` |
| Skill | uninstallSkill | `DELETE /api/skills/:id/install` |
| Knowledge | listKnowledgeBases | `GET /api/knowledge-bases` |
| Knowledge | createKnowledgeBase | `POST /api/knowledge-bases` |
| Knowledge | listKbDocuments | `GET /api/knowledge-bases/:id/documents` |
| Knowledge | searchKnowledge | `GET /api/knowledge/search?q&kbId&limit` |
| Knowledge | mountKnowledgeBase | `POST /api/knowledge-bases/:id/mount` |
| Knowledge | listMounts | `GET /api/knowledge/mounts` |
| MCP | listConnectors | `GET /api/connectors` |
| MCP | createConnector | `POST /api/connectors` |
| MCP | approveConnector | `POST /api/connectors/:id/approve` |
| MCP | authorizeConnector | `POST /api/connectors/:id/authorize` |
| MCP | listAuthorizedConnectors | `GET /api/connectors/authorized` |
| Memory | listMemory | `GET /api/memory?q&namespace&visibility&limit&offset` |
| Memory | listMemoryNamespaces | `GET /api/memory/namespaces` |
| Memory | createMemory | `POST /api/memory` |
| Memory | deleteMemory | `DELETE /api/memory/:id` |
| Memory | promoteMemory | `POST /api/memory/:id/promote` |

> `/api/*` → `/platform-api/*` 的 namespace 迁移记为 follow-up;本阶段不扩大范围。

## 3. 请求/错误模型

```ts
class PlatformApiError extends Error {
  readonly status: number   // 0 = 网络失败
  readonly code: string     // 网关 error/code,或 http-<status>
}
```

- 非 2xx → `PlatformApiError`;网络异常 → `status=0, code='network-error'`。
- `errorMessage()` 将其映射为用户可读文案(网络失败/服务不可用/请求被拒绝)。

## 4. 模型层(load + mutation+reload)

每个域一个 model 文件,导出纯函数(可测):

```text
loadSkills(api, query)   → ResourceState<{skills,total,installedIds}>
createSkillAndReload / installSkillAndReload / uninstallSkillAndReload / publishSkillAndReload
loadKnowledge / createKnowledgeBaseAndReload / mountKnowledgeBaseAndReload
loadDocuments / searchChunks
loadMcp / createConnectorAndReload / approveConnectorAndReload / authorizeConnectorAndReload
loadMemory / createMemoryAndReload / deleteMemoryAndReload / promoteMemoryAndReload
```

- `ResourceState<T> = loading | ready | empty | error`(纯状态机,`models/resource.ts`)。
- mutation 语义:**真实 API 调用成功后重新读取服务端**(`AndReload`),不只改 React state、不吞错。
- `empty` 由「真实数据为空」判定,不硬编码 count=0、不注入 sample。

## 5. 测试(无网络/浏览器)

| 测试 | 覆盖 |
|---|---|
| `tests/platform-api.test.ts` | URL/method/CSRF/JSON body/错误归一/网络失败/身份字段不外传 |
| `tests/models.test.ts` | loading/ready/empty/error;mutation 调用顺序与重新读取;失败可见 |
| `tests/client-contract.test.mjs` | bundle 包装、四 Panel 注册、cmcc.smoke 不存在、品牌槽、baseline externals |
