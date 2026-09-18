/**
 * 每用户 dsh 运行时驱动骨架 —— **实验性 / 未激活**。
 *
 * 状态:`DEFERRED_WITHOUT_PRODUCTION_PATH`(02C 判定)。
 *
 * 依据:
 * - 全仓库 grep 无生产 import / 调用点;唯一提及是 `routes/platform.ts` 的
 *   `/api/sessions/migrate` 返回 501(`s2-requires-sdk`),该 route **不调用**本包。
 * - 生产 Runtime 实际由 `apps/gateway/src/supervisor.ts` 直接 spawn `dsh` 进程,
 *   不依赖本包。
 * - 原 peerDependencies 锁的是 0.1.1 时代版本(`0.1.2-rc.1`),与 0.1.5 基线不一致,
 *   已移除以免误导(autoInstallPeers=false,本包也不在任何 workspace 依赖路径上)。
 *
 * 因此本包保留为接口骨架,方法体为 TODO,但**不在 active production path**。
 * 若未来启用,必须按 0.1.5-rc.2 官方 SDK exact contract 实现并补 contract tests。
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
