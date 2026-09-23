/**
 * cmcc-workspace-bootstrap —— CMCC 平台默认 Workspace 引导(Host-only dsh 插件)。
 *
 * 普通用户不应依赖 host OS 的 native directory picker 才能开始第一轮对话。
 * Supervisor 在 spawn 时注入可信 env:
 *   CMCC_DEFAULT_WORKSPACE_PATH   —— 服务端生成的 per-user 受控目录(绝对路径)
 *   CMCC_DEFAULT_WORKSPACE_TITLE  —— 展示标题(默认「我的工作区」)
 *
 * 插件经官方 `ctx.workspaceRegistry.create(path, title)` 注册/复用 workspace:
 *   - 幂等:相同 canonical path 返回既有记录
 *   - 目录必须真实存在(否则 create reject → 可观测失败,不 crash Runtime)
 *   - 不接 DB、不接 browser sid、不复用 launch token
 *
 * 契约来源:`.tools/dsh-0.1.5-rc.2/.../@deepseek-ai/dsh-workspace/lib/types/index.d.ts`
 * (`WorkspaceRegistry.create(path, title?)`)。
 * 详见 docs/implementation/REWORK-08A-workspace-contract.md。
 *
 * 诊断日志(脱敏,不含 cookie/token/secret;仅经 stderr 输出):
 *   workspace-bootstrap start | env-valid | path-valid | create | ready | error
 */
import { stat } from 'node:fs/promises'

export const name = 'cmcc-workspace-bootstrap'
export const inject = ['workspaceRegistry']

interface Workspace {
  readonly id: string
  readonly path: string
  readonly title: string
}

interface WorkspaceRegistry {
  create(path: string, title?: string): Promise<Workspace>
}

interface PluginLogger {
  info?: (message: string) => void
  warn?: (message: string) => void
}

interface PluginContext {
  workspaceRegistry: WorkspaceRegistry
  logger?: PluginLogger
}

/** 结构化诊断日志:默认 stderr(由 supervisor 捕获),可注入 logger。 */
function emit(logger: PluginLogger | undefined, level: 'info' | 'warn', message: string): void {
  if (level === 'warn') {
    if (logger?.warn) logger.warn(message)
    else process.stderr.write(`${message}\n`)
  } else if (logger?.info) {
    logger.info(message)
  } else {
    process.stderr.write(`${message}\n`)
  }
}

/** 校验目录存在且为目录(create 内部也会 realpath,这里提前给出可读错误)。 */
async function isExistingDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 注册/复用平台默认 workspace。失败不抛(不 crash Runtime),写结构化 warning。
 * @returns 是否成功注册。
 */
export async function bootstrapDefaultWorkspace(
  registry: WorkspaceRegistry,
  workspacePath: string,
  title: string,
  logger?: PluginLogger,
): Promise<boolean> {
  if (workspacePath === '') {
    emit(logger, 'info', 'workspace-bootstrap skip code=no-env')
    return false
  }
  emit(logger, 'info', 'workspace-bootstrap env-valid')
  if (!(await isExistingDirectory(workspacePath))) {
    emit(logger, 'warn', 'workspace-bootstrap error code=path-missing')
    return false
  }
  emit(logger, 'info', 'workspace-bootstrap path-valid')
  try {
    const workspace = await registry.create(workspacePath, title)
    emit(logger, 'info', `workspace-bootstrap create path=${workspace.path} title=${workspace.title}`)
    emit(logger, 'info', `workspace-bootstrap ready workspaceId=${workspace.id}`)
    return true
  } catch (err) {
    emit(logger, 'warn', `workspace-bootstrap error code=create-failed detail=${String(err)}`)
    return false
  }
}

export async function apply(ctx: PluginContext): Promise<void> {
  emit(ctx.logger, 'info', 'workspace-bootstrap start')
  const workspacePath = process.env.CMCC_DEFAULT_WORKSPACE_PATH ?? ''
  if (workspacePath === '') return
  const title = process.env.CMCC_DEFAULT_WORKSPACE_TITLE ?? '我的工作区'
  await bootstrapDefaultWorkspace(ctx.workspaceRegistry, workspacePath, title, ctx.logger)
}
