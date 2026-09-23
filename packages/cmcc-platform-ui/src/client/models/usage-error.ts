import { PlatformApiError } from '../platform-api.js'

/** 不向用户暴露网关异常的 SQL、堆栈或内部错误码。 */
export function usageErrorMessage(error: unknown): string {
  if (error instanceof PlatformApiError) {
    if (error.status === 401) return '登录已失效，请重新登录后再试。'
    if (error.status === 403 || error.status === 404) return '无权查看用量统计，请确认当前账号为租户管理员。'
    if (error.status === 0) return '网络连接失败，请检查网关是否正在运行。'
  }
  return '统计服务暂时不可用，请稍后重试或查看网关日志。'
}
