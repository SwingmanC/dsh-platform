/**
 * 通用资源加载状态:loading / ready / empty / error。
 *
 * 四个 Panel 共用;`load*` 纯函数返回该状态,便于在无浏览器环境下测试。
 * 禁止:永远 loading、catch 吞错、API 失败仍显示空数组。
 */

export type ResourceState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'empty'; data: T }
  | { status: 'error'; message: string }

/** 把「数量为 0」归一为 empty,否则 ready。 */
export function classify<T>(data: T, isEmpty: (data: T) => boolean): ResourceState<T> {
  return isEmpty(data) ? { status: 'empty', data } : { status: 'ready', data }
}

/** 执行一个加载函数,把异常归一为 error(不吞错、不返回假空)。 */
export async function runLoad<T>(load: () => Promise<T>, isEmpty: (data: T) => boolean): Promise<ResourceState<T>> {
  try {
    const data = await load()
    return classify(data, isEmpty)
  } catch (err) {
    return { status: 'error', message: errorMessage(err) }
  }
}

/** 用户可理解的错误文案(不暴露 stack / SQL / token)。 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message
    if (msg === '' || msg === 'Failed to fetch') return '网络请求失败,请重试'
    if (/^http-5\d\d$/.test(msg)) return '服务暂时不可用,请稍后重试'
    if (/^http-4\d\d$/.test(msg)) return '请求被拒绝,请刷新后重试'
    return msg
  }
  return '发生未知错误'
}
