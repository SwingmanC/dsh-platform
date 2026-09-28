# 租户内人员管理

本模块沿用现有 tenant_admin / operator / member 单角色模型，不引入部门或新的角色体系。

## 功能与入口

租户管理员登录 DSH 后，侧边栏显示“人员管理”（cmcc.users）。支持：

- 分页列表，按姓名/邮箱、角色、启停状态筛选。
- 创建人员，填写姓名、邮箱、初始密码和角色；默认普通成员。
- 编辑姓名、邮箱和角色；启用/停用账号；重置密码。
- 删除人员前二次确认，逻辑删除后从列表移除、禁止登录、使旧会话失效并停止本地 Runtime。
- 仅查看、修改当前租户人员；operator/member 无管理入口，直接请求接口也被拒绝。

本期不提供物理删除、删除恢复、部门、邀请通知、自助注册、强制首次改密。停用不会删除历史会话、记忆或工作区；密码由管理员通过安全方式告知成员，不在成功响应中回显。

## 授权和会话

所有管理写请求经过现有平台会话和 CSRF 校验，tenant_id/操作者从服务器会话获取，body/query 不接受自报身份字段。

修改邮箱、角色、状态或密码时，数据库 auth_version 递增；每次读取平台会话校验账号有效状态、租户、角色和版本。旧 Cookie 即使留在 Redis 或另一网关的内存中也不能通过后续请求校验；无需 Redis 扫描删除。姓名更新不强制退出，下一次请求使用最新姓名。

删除只设置 deleted_at、停用账号并递增 auth_version，保留用户记录、工作区、历史会话和审计关联；原邮箱继续占用。登录、会话校验和人员管理查询均排除已删除人员，编辑、启用或重置密码接口不能恢复账号。

禁止删除、停用或降权当前登录管理员，并保护最后一名启用中的管理员。事务锁定租户行并复核操作者身份，安全更新与最后管理员检查在同一事务执行，避免并发操作导致管理员全部失效。

安全变更同时撤销当前 Gateway 中的内部 Runtime Token，终止该用户的本地 Runtime，并使准备中的旧启动任务失效。停止失败时账号修改已提交、旧会话仍失效，响应 runtimeStopped=false，页面明确提示联系运维；不将业务已成功的修改伪装为未发生。

当前 Supervisor 为单网关进程内注册表。跨网关的持久会话校验有效，但远端已建立的 WS/运行中任务和内部令牌回收仍需要分布式通知与进程编排；本模块不宣称支持多网关即时终止任务。

## 数据库升级

新建库的 schema.sql 已包含字段和索引。存量库按顺序执行 `db/migrations/012-user-management.sql` 和 `db/migrations/013-user-soft-delete.sql`；已执行 012 的库只需执行 013，不要重复执行迁移或运行会 DROP TABLE 的 db:init。

升级前检查：

```sql
SELECT LOWER(TRIM(email)), COUNT(*)
FROM t_dsh_users
GROUP BY LOWER(TRIM(email))
HAVING COUNT(*) > 1;
```

当前登录只提交邮箱，不提交租户，所以升级增加全局唯一邮箱索引。发现重复邮箱时先确认账号归属并人工处理，迁移不会自动合并/删除账号。登录对未处理的重复邮箱返回认证失败，不再 LIMIT 1 随机选人。

012 增加 auth_version（默认 0）和 uk_users_email 索引；013 增加 deleted_at（默认 NULL）。已有用户 ID、租户、角色、状态和密码哈希保持不变，既有版本 0 会话在账号未发生安全变更时仍有效。需先迁移、再部署新后端，否则会话校验会因缺少字段失败。

部署时构建 shared、Gateway 与 cmcc-platform-ui，重启 Gateway 并刷新 DSH；若旧 Runtime 缓存插件 bundle，重新进入运行时。依赖锁文件只新增 shared 的 workspace 链接，无新第三方依赖。

## 接口

| 接口 | 功能 |
| --- | --- |
| GET /api/admin/users | q、role、status、page（默认 1）、pageSize（默认 20，上限 100） |
| POST /api/admin/users | 创建，email/displayName/password/role |
| PATCH /api/admin/users/:id | 编辑，email/displayName/role/status |
| POST /api/admin/users/:id/reset-password | 重置，password |
| DELETE /api/admin/users/:id | 逻辑删除，返回 ok、runtimeStopped |

未认证 401；非管理员或跨租户目标 404；输入无效 400；邮箱不可用或管理员保护 409。密码长度 10–128 字符，不得全为空白；存 Argon2id 哈希。API 和错误日志不返回 SQL、密码哈希或原始异常。

user.create/user.update/user.password.reset/user.delete 写入现有审计表，记录操作者、目标 ID、变更字段及非敏感状态。审计写入失败输出仅带动作的安全告警，不改变人员操作结果。

## 验证

```sh
pnpm --filter @dsh-platform/shared build
pnpm --filter @dsh-platform/gateway typecheck
pnpm --filter @dsh-platform/cmcc-platform-ui build
pnpm --filter @dsh-platform/cmcc-platform-ui typecheck
pnpm --filter @dsh-platform/gateway test
pnpm --filter @dsh-platform/cmcc-platform-ui test
```

真实 MySQL 集成测试（仅允许本地数据库；创建和清理测试专属临时库，不修改业务库）：

```sh
cd apps/gateway
USER_MANAGEMENT_MYSQL=1 node --import tsx --test tests/user-management-mysql.test.ts
```

浏览器测试渲染实际 UsersPanel，接口使用隔离的模拟数据，不改真实人员；覆盖创建、编辑角色、停用、重置密码、删除确认/取消/失败重试、删除末页人员后的分页、筛选、错误重试和普通成员拒绝：

```sh
PLAYWRIGHT_CHANNEL=chrome node scripts/users-ui-smoke.mjs
```

使用已安装 Chrome；若已安装 Playwright Chromium，可不设置 PLAYWRIGHT_CHANNEL。截图输出到 /tmp/dsh-users-panel.png 、/tmp/dsh-users-create.png 和 /tmp/dsh-users-delete.png。
