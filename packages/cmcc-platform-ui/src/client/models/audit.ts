import { PlatformApiError } from '../platform-api.js'

export const AUDIT_ACTIONS: Record<string, string> = {
  'login.success': '登录成功', 'login.failed': '登录失败', 'login.locked': '登录锁定', logout: '注销',
  'user.create': '创建人员', 'user.update': '修改人员', 'user.password.reset': '重置密码', 'user.delete': '删除人员',
  'skill.create': '创建技能', 'skill.update': '更新技能', 'skill.publish': '发布技能', 'skill.install': '安装技能', 'skill.uninstall': '卸载技能',
  'knowledge.create': '创建知识库', 'knowledge.document.upload': '导入文档', 'knowledge.mount': '挂载知识库', 'knowledge.unmount': '取消挂载知识库',
  'connector.create': '创建 MCP 服务', 'connector.approve': '审批 MCP 服务', 'connector.disable': '禁用 MCP 服务',
  'connector.authorize': '授权 MCP 服务', 'connector.revoke': '撤销 MCP 授权', 'connector.credential.rotate': '轮换 MCP 凭据',
  'memory.create': '创建记忆', 'memory.delete': '删除记忆', 'memory.promote': '调整记忆共享范围',
  'workspace.create': '创建工作区', 'workspace.recreate': '重建工作区', 'workspace.missing': '工作区缺失', 'session.enter': '进入会话',
  'runtime.start': '启动运行时', 'runtime.ready': '运行时就绪', 'runtime.dead': '运行时退出', 'runtime.drain': '回收运行时',
  'runtime.ensure': '准备运行时', 'session.migrate': '迁移会话', 'projection.sync': '同步配置', 'security.access.denied': '访问被拒绝',
}
export const AUDIT_RESULTS = { SUCCESS: '成功', DENIED: '拒绝', ERROR: '失败' } as const
export const AUDIT_RESOURCES: Record<string, string> = { login: '认证', logout: '认证', user: '人员', skill: '技能', knowledge: '知识库',
  connector: 'MCP 服务', memory: '记忆', workspace: '工作区', session: '会话', runtime: '运行时', security: '安全', projection: '配置同步' }

export function auditErrorMessage(error: unknown): string {
  if (!(error instanceof PlatformApiError)) return '加载审计日志失败，请稍后重试。'
  if (error.status === 401) return '登录已失效，请重新登录。'
  if (error.status === 404) return '无权查看审计日志，或记录已不可访问。'
  if (error.status === 0) return '网络连接失败，请检查网络后重试。'
  if (error.code === 'invalid-audit-query') return '筛选条件无效，请检查时间范围后重试。'
  return '审计服务暂时不可用，请稍后重试。'
}

export function auditTime(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value
}
