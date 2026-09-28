import { PlatformApiError } from '../platform-api.js'

export const USER_ROLES = { tenant_admin: '租户管理员', operator: '操作员', member: '普通成员' } as const

export function userErrorMessage(error: unknown): string {
  if (!(error instanceof PlatformApiError)) return '操作失败，请稍后重试。'
  if (error.status === 401) return '登录已失效，请重新登录。'
  if (error.status === 0) return '网络连接失败，请检查网络后重试。'
  const messages: Record<string, string> = {
    'email-unavailable': '此邮箱不可用，请使用其他邮箱。',
    'invalid-email': '请输入有效的邮箱地址。',
    'invalid-display-name': '姓名不能为空，且不能超过 128 个字符。',
    'invalid-password': '密码长度须为 10–128 个字符，不能全部为空白。',
    'invalid-role': '请选择有效的角色。',
    'invalid-status': '请选择有效的账号状态。',
    'invalid-user-input': '请检查填写的信息。',
    'invalid-user-query': '筛选条件无效，请重置后重试。',
    'cannot-disable-or-demote-self': '不能停用自己或降低自己的管理员角色。',
    'last-tenant-admin': '租户至少需要保留一名启用的管理员。',
    'cannot-delete-self': '不能删除当前登录账号。',
    'not-found': '无权管理人员，或该人员已不可访问。',
  }
  if (error.status === 429) return '操作过于频繁，请稍后重试。'
  return messages[error.code] ?? '人员管理服务暂时不可用，请稍后重试。'
}
