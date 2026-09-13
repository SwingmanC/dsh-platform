/**
 * 每用户 dsh 运行时驱动骨架(总方案 §5/§8、platform 设计 T2)。
 *
 * 最终形态:以 @deepseek-ai/dsh-sdk-client(peerDependency,锁 0.1.2-rc.1)
 * 驱动该用户的 `dsh` 子进程 —— ensure(拉起/home 初始化/env 注入)、
 * create/resume/prompt/cancel/follow/page、崩溃后 resume(由 dsh 自行闭合
 * interrupted 轮次)。本骨架只固化对外接口,方法体随 T2 落地。
 */
export interface DshDriverOptions {
  userId: string
  /** 该用户专属 $DSH_HOME(会话历史、凭据、设置的根)。 */
  homeDir: string
  /** 该用户的工作区父目录,所有会话 cwd 必须位于其下。 */
  workspaceRoot: string
}

export interface DshSessionHandle {
  sessionId: string
}

export class DshRuntimeDriver {
  constructor(private readonly options: DshDriverOptions) {}

  get homeDir(): string {
    return this.options.homeDir
  }

  get workspaceRoot(): string {
    return this.options.workspaceRoot
  }

  /** 拉起(或复用)该用户的 dsh 进程,ready 后返回。 */
  async ensure(): Promise<void> {
    throw new Error('TODO(T2): 经 @deepseek-ai/dsh-sdk-client 拉起 dsh 子进程')
  }

  /** 在指定 cwd 创建会话;cwd 必须位于 workspaceRoot 内。 */
  async createSession(_cwd: string): Promise<DshSessionHandle> {
    throw new Error('TODO(T2): SDK create session')
  }

  /** 恢复既有会话(崩溃/回收后的接管路径)。 */
  async resume(_sessionId: string): Promise<DshSessionHandle> {
    throw new Error('TODO(T2): SDK resume session')
  }

  /** 发送一轮用户输入。 */
  async prompt(_sessionId: string, _text: string): Promise<void> {
    throw new Error('TODO(T2): SDK prompt')
  }

  /** 从 fromSeq 起订阅事件流(follow:opening snapshot + 无 gap 增量帧)。 */
  async follow(_sessionId: string, _fromSeq: number): Promise<AsyncIterable<unknown>> {
    throw new Error('TODO(T2): SDK follow')
  }

  /** 优雅回收:等待空闲 → teardown(最终 flush,不丢事件)→ 退出进程。 */
  async drain(): Promise<void> {
    throw new Error('TODO(T2): idle drain')
  }
}
