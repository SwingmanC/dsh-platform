# 审计日志第一期

本期以 qwen-java 的审计模块为参考，完成平台操作的统一写入、租户隔离查询和 DSH 内嵌审计管理面板。

## 使用和升级

租户管理员登录后，在 DSH 侧边栏「人员管理」下方打开「审计日志」。可以按操作人姓名、动作、资源类型、结果、时间范围筛选，分页浏览并打开只读详情抽屉。时间选择器采用浏览器本地时区，发送给网关时转换为 UTC；新事件以 UTC 写入。详情抽屉支持 Escape 关闭及键盘焦点约束。

已有数据库只执行一次 `db/migrations/014-audit-log.sql`。首次建库使用已更新的 `db/schema.sql`，不要对存量库运行初始化脚本（该脚本含 DROP TABLE）。本次开发只在独立临时测试库验证迁移，没有升级业务数据库。

```sh
mysql --default-character-set=utf8mb4 -h127.0.0.1 -P3306 -uroot -p < db/migrations/014-audit-log.sql
pnpm --filter @dsh-platform/shared build
pnpm --filter @dsh-platform/cmcc-platform-ui build
pnpm --filter @dsh-platform/gateway build
```

升级数据库后重启网关；已有 DSH Runtime 需要重启以载入新版 UI 插件。迁移未执行时审计写入会告警、查询会返回可读的服务错误，业务请求不会因审计写入失败而被拒绝。

若网关经反向代理部署，在环境中配置 `TRUSTED_PROXIES` 为实际代理 IP/CIDR，多个值用逗号分隔，例如 `127.0.0.1,::1`。默认不信任转发头；审计 IP 与登录防爆破使用 Fastify 在此信任范围内解析的 `req.ip`，不会自行读取任意 X-Forwarded-For。该设置也影响现有登录限速的 IP 归属，部署时应配置正确。

## 事件覆盖

| 范围 | 已接入动作 |
|---|---|
| 认证 | 登录成功、失败、锁定、注销 |
| 人员 | 创建、更新（角色/启停等）、重置密码、逻辑删除 |
| 技能 | 创建、更新、发布、安装、卸载 |
| 知识库 | 创建、文档导入、挂载、取消挂载 |
| MCP | 创建、审批、禁用、授权、撤销授权、凭据轮换 |
| 记忆 | 创建、删除、调整共享范围；现有内部写入同样通过统一入口 |
| 工作区/会话 | 创建、重建、工作区缺失、进入会话 |
| 运行时 | 启动、就绪、启动失败、退出、回收 |
| 安全/同步 | 已匹配的平台 API 访问拒绝，主要写操作的早期校验/CSRF拒绝，配置投影同步失败 |

只覆盖现有业务入口，没有新增知识库文档删除等业务 API。Agent 实际工具调用、模型调用正文及完整运行轨迹留待第二期。读取成功、轮询及复用已就绪运行时不会反复写审计。

业务服务显式记录完成的变更；返回 false 的变更记录为 DENIED，不根据 HTTP 200 推断成功。写入后的配置投影同步失败单独记录 projection.sync ERROR，保留此前的变更成功记录。请求钩子补记业务服务未处理的校验/认证/权限拒绝和失败；同一请求已有对应失败事件时不重复写。资源不可见的 404 仍按原有契约返回，审计只记录请求目标，不探测其他租户资源详情。

## 数据与安全

现有表保留 tenant_id、actor、action、subject、payload、at，新增 actor_name、resource_type、resource_id、result、reason_code、request_id、client_ip、user_agent、source。操作者名称取认证主体或登录时服务端查得的身份快照，不依赖查询时 JOIN 用户表。日志 ID 始终以十进制字符串返回，防止 BIGINT 精度丢失。

登录成功在会话建立后显式传入服务端账号身份；已唯一确定账号的密码失败/禁用事件同样归属对应租户。未知账号、邮箱存在歧义或在锁定门禁处无法可靠确定账号时，tenant_id/actor 留空。这些平台级事件不通过租户审计 API 返回。

payload 仅接受业务摘要字段白名单，并递归遮蔽敏感键、限制深度/数组长度/字符串长度及 4096 字节总量。超限时返回有效的 `{ "truncated": true }` JSON，不截断 JSON 文本。密码、凭据、请求体、对话/文档正文、完整工具参数和 SQL 异常不写入。历史 payload 查询时也经过白名单和脱敏；迁移不会改写历史原始数据。

历史新增字段保持 NULL，页面显示「未记录」，不猜测历史结果、来源或操作者。历史 at 没有时区信息，新查询按 UTC 解释。当前本地库已确认 ID 1–28 是按北京时间保存的旧记录，已通过 `015-audit-legacy-time-utc.sql` 转为 UTC。原始时间保存在 `t_dsh_audit_time_corrections`，脚本重复执行不会再次减 8 小时。该脚本只适用于已核实的当前数据范围，其他环境须先确认旧记录时区及切换边界，不能直接照搬 ID 28。

查询入口只允许 tenant_admin；operator/member 返回 404。列表、总数和详情在 Repository 层均强制 tenant_id 条件；前端不能传 tenantId 扩大范围。没有平台管理员全局读取入口。表无用户级外键级联删除，用户删除不会删除审计记录。

## API

- `GET /api/audit/events`：返回 `{ items, total, page, pageSize }`。
- 筛选：actor（用户 ID）、actorName（名称包含匹配，%/_按字面量处理）、action、resourceType、result、from/to（ISO UTC 时间）。
- page 从 1 开始；pageSize 默认 20，最大 100；按 at DESC、id DESC 排序。
- `GET /api/audit/events/:id`：返回一条本租户记录；其他租户、平台级事件或不存在的记录均返回 404。
- 以上路径在平台 authority 和 DSH UI authority 都归平台认证处理。

## 写入故障与边界

AuditService 是唯一写入入口，Repository 负责数据库插入和查询。写入失败增加进程内 failures 计数并输出不包含 SQL/详情的结构化警告；单次等待最多 1500ms，同时最多 10 个未完成写入。写入使用独立连接池（2 个连接、最多 8 个排队请求），避免占用业务连接池；连接和 SQL 执行均设置超时。等待超时后底层插入仍可能完成，不能把超时告警解释为确定丢失。

当前是旁路写入，没有事务 outbox 和持久重试。数据库失败、超时或容量达到上限时可能丢失事件；不保证审计完整性或防篡改。批量字段更新、文档多步骤导入等已有业务操作也没有因本期审计改造而获得事务原子性。关键变更可靠投递和日志归档另行设计。

## 验证

```sh
pnpm --filter @dsh-platform/gateway test
pnpm --filter @dsh-platform/cmcc-platform-ui test
AUDIT_MYSQL=1 pnpm --filter @dsh-platform/gateway exec node --import tsx --test tests/audit-mysql.test.ts
PLAYWRIGHT_CHANNEL=chrome node scripts/audit-ui-smoke.mjs
```

MySQL 测试仅连接本机，创建/清理专用临时库，验证真实迁移、历史数据、租户范围、时间筛选、稳定分页和 BIGINT。浏览器测试使用真实 AuditPanel 与隔离的模拟 API，验证筛选、时区、分页、抽屉、错误恢复、移动布局和非管理员拒绝。
