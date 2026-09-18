import { ensureRuntime } from './supervisor.js'
import { config } from './config.js'
import { queryMany } from './db.js'

interface BindingRow {
  sessionId: string
  title: string | null
  workspace: string
  workspaceId: string | null
  updatedAt: string
}

/**
 * 向用户实例发起 dsh RPC 调用(session.create),使平台的会话显示在 dsh 侧栏。
 * 当前为最佳尝试(RPC 协议以 dsh SDK 为准),失败仅记日志,不阻断流程。
 */
export async function seedUserSessions(userId: string, tenantId: string): Promise<void> {
  try {
    const runtime = await ensureRuntime({ userId, tenantId, displayName: '' })
    if (!runtime.port) return
    const upstream = `http://127.0.0.1:${runtime.port}`

    const bindings = await queryMany<BindingRow>(
      `SELECT session_id AS sessionId, title, workspace, workspace_id AS workspaceId, updated_at AS updatedAt
         FROM t_dsh_agent_bindings
        WHERE user_id = ? AND status = 'active'
        ORDER BY updated_at DESC LIMIT 50`,
      [userId],
    )

    for (const binding of bindings) {
      try {
        await callDshRpc(upstream, 'session.create', {
          id: binding.sessionId,
          options: {
            meta: {
              cwd: binding.workspace,
              createdAt: binding.updatedAt ? new Date(binding.updatedAt).getTime() : Date.now(),
            },
          },
        })
      } catch {
        // 单条失败不影响后续
      }
    }
  } catch {
    // 实例未启动等整体性失败
  }
}

interface RpcEnvelope {
  type: 'client-request'
  rpcId: string
  method: string
  payload: unknown
}

let rpcSeq = 0

async function callDshRpc(upstream: string, method: string, payload: unknown): Promise<unknown> {
  const rpcId = `seed-${++rpcSeq}`
const body: RpcEnvelope = { type: 'client-request', rpcId, method, payload }
  const res = await fetch(`${upstream}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: config.dsh.uiAuthority },
    signal: AbortSignal.timeout(15_000),
  })
  const data = (await res.json()) as { type?: string; result?: { ok?: boolean; error?: { code?: string } } }
  if (data.type === 'server-response' && data.result?.ok === false) {
    throw new Error(data.result.error?.code ?? 'rpc-failed')
  }
  return data
}