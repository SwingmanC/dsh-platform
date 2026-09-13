import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

export interface RuntimeInfo {
  runtimeId: string
  state: 'starting' | 'ready' | 'draining' | 'dead'
  homeDir: string
}

const homesRoot = process.env.DSH_HOMES_ROOT ?? './var/homes'

/**
 * Supervisor 占位(总方案 §8 / platform 设计 T2):
 * 最终形态 = 按用户拉起 `dsh` 实例(独立 $DSH_HOME、env 注入解密后的凭据、
 * --trusted-host 平台 authority、stdout 解析 launch token)、心跳与死亡恢复、
 * 空闲回收、升级排空。当前骨架只分配每用户 home 目录,进程拉起随 T2 接入。
 */
export async function ensureRuntime(user: { userId: string }): Promise<RuntimeInfo> {
  const homeDir = path.resolve(homesRoot, user.userId)
  await mkdir(homeDir, { recursive: true })
  return { runtimeId: randomUUID(), state: 'starting', homeDir }
}
