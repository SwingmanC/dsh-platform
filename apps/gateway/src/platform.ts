import { randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { SessionListItem, Workspace } from '@dsh-platform/shared'
import { config } from './config.js'
import { execute, queryMany, queryOne } from './db.js'

/** t_dsh_workspaces 行(platform 设计 §7)。 */
export interface WorkspaceRecord {
  id: string
  userId: string
  canonicalPath: string
  displayName: string
  lastUsedAt: string | null
  archivedAt: string | null
  missingSince: string | null
}

/** t_dsh_agent_bindings 行(会话登记;权威在网关,不在请求路径上)。 */
export interface BindingRecord {
  sessionId: string
  title: string | null
  workspaceId: string | null
  workspace: string
  status: string
  updatedAt: string
}

export function userWorkspaceRoot(userId: string, tenantId: string): string {
  return path.join(config.dsh.workspacesRoot, tenantId, userId)
}

/** 路径是否位于该用户合法根之内(S1 重建 / 创建工作区的越界防护)。 */
export function isWithinUserRoot(userId: string, tenantId: string, candidate: string): boolean {
  const root = path.resolve(userWorkspaceRoot(userId, tenantId))
  const target = path.resolve(candidate)
  if (target === root) return true
  const rel = path.relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p)
    return s.isDirectory()
  } catch {
    return false
  }
}

/** 工作区名:单层目录名,拒绝路径分隔符与控制字符。 */
export function sanitizeWorkspaceName(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed === '' || trimmed.length > 64) return null
  // eslint-disable-next-line no-control-regex
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(trimmed)) return null
  if (trimmed === '.' || trimmed === '..') return null
  return trimmed
}

const WORKSPACE_COLUMNS = `id, user_id AS userId, canonical_path AS canonicalPath,
  display_name AS displayName, last_used_at AS lastUsedAt, archived_at AS archivedAt,
  missing_since AS missingSince`

/** 列出工作区,并按文件系统巡检刷新 missing_since(platform 设计 §6.2)。 */
export async function listWorkspaces(userId: string): Promise<Array<WorkspaceRecord & { exists: boolean }>> {
  const rows = await queryMany<WorkspaceRecord>(
    `SELECT ${WORKSPACE_COLUMNS} FROM t_dsh_workspaces WHERE user_id = ? ORDER BY last_used_at DESC`,
    [userId],
  )
  const out: Array<WorkspaceRecord & { exists: boolean }> = []
  for (const row of rows) {
    const exists = await pathExists(row.canonicalPath)
    if (exists && row.missingSince !== null) {
      await execute('UPDATE t_dsh_workspaces SET missing_since = NULL WHERE id = ?', [row.id])
      row.missingSince = null
    } else if (!exists && row.missingSince === null) {
      await execute('UPDATE t_dsh_workspaces SET missing_since = UTC_TIMESTAMP(3) WHERE id = ?', [row.id])
      row.missingSince = new Date().toISOString()
    }
    out.push({ ...row, exists })
  }
  return out
}

export async function findWorkspace(userId: string, canonicalPath: string): Promise<WorkspaceRecord | undefined> {
  return queryOne<WorkspaceRecord>(
    `SELECT ${WORKSPACE_COLUMNS} FROM t_dsh_workspaces WHERE user_id = ? AND canonical_path = ?`,
    [userId, canonicalPath],
  )
}

export async function registerWorkspace(
  userId: string,
  canonicalPath: string,
  displayName: string,
): Promise<WorkspaceRecord> {
  const existing = await findWorkspace(userId, canonicalPath)
  if (existing !== undefined) {
    await execute(
      'UPDATE t_dsh_workspaces SET last_used_at = UTC_TIMESTAMP(3), missing_since = NULL WHERE id = ?',
      [existing.id],
    )
    return { ...existing, missingSince: null }
  }
  const id = randomUUID()
  await execute(
    `INSERT INTO t_dsh_workspaces (id, user_id, canonical_path, display_name, last_used_at)
     VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3))`,
    [id, userId, canonicalPath, displayName],
  )
  return { id, userId, canonicalPath, displayName, lastUsedAt: null, archivedAt: null, missingSince: null }
}

/** 在用户根下创建新工作区目录并登记。 */
export async function createWorkspace(userId: string, tenantId: string, name: string): Promise<WorkspaceRecord> {
  const safe = sanitizeWorkspaceName(name)
  if (safe === null) throw new Error('invalid-workspace-name')
  const dir = path.join(userWorkspaceRoot(userId, tenantId), safe)
  if (!isWithinUserRoot(userId, tenantId, dir)) throw new Error('outside-root')
  await mkdir(dir, { recursive: true })
  return registerWorkspace(userId, dir, safe)
}

/** S1:原路径重建(仅限用户根内,platform 设计 §6.3)。 */
export async function recreateWorkspace(userId: string, tenantId: string, canonicalPath: string): Promise<void> {
  if (!isWithinUserRoot(userId, tenantId, canonicalPath)) throw new Error('outside-root')
  await mkdir(canonicalPath, { recursive: true })
  await execute(
    'UPDATE t_dsh_workspaces SET missing_since = NULL WHERE user_id = ? AND canonical_path = ?',
    [userId, canonicalPath],
  )
}

/** 默认工作区展示标题。 */
export const DEFAULT_WORKSPACE_TITLE = '我的工作区'

/**
 * 确保用户的默认工作区存在并登记(幂等)。普通用户首次访问/冷启动/重启/idle 后
 * 自动 provisioning,使其无需依赖 host OS native directory picker 即可开始对话。
 *
 * - 路径由服务端按 tenant/user 生成,不接受请求指定。
 * - 目录真实创建;越界校验。
 * - 平台 DB 行幂等登记(`registerWorkspace`)。
 */
export async function ensureDefaultWorkspace(userId: string, tenantId: string): Promise<{ path: string; title: string }> {
  const dir = path.join(userWorkspaceRoot(userId, tenantId), 'default')
  if (!isWithinUserRoot(userId, tenantId, dir)) throw new Error('outside-root')
  await mkdir(dir, { recursive: true })
  await registerWorkspace(userId, dir, DEFAULT_WORKSPACE_TITLE)
  return { path: dir, title: DEFAULT_WORKSPACE_TITLE }
}

export async function listSessions(userId: string): Promise<SessionListItem[]> {
  return queryMany<SessionListItem>(
    `SELECT session_id AS sessionId, title, workspace_id AS workspaceId, workspace,
            updated_at AS updatedAt, status
       FROM t_dsh_agent_bindings
      WHERE user_id = ? AND status = 'active'
      ORDER BY updated_at DESC`,
    [userId],
  )
}

export async function findBinding(userId: string, sessionId: string): Promise<BindingRecord | undefined> {
  return queryOne<BindingRecord>(
    `SELECT session_id AS sessionId, title, workspace_id AS workspaceId, workspace, status,
            updated_at AS updatedAt
       FROM t_dsh_agent_bindings
      WHERE session_id = ? AND user_id = ?`,
    [sessionId, userId],
  )
}

/** 缺工作区时给前端的兜底 workspace(未登记在库)。 */
export function unregisteredWorkspace(userId: string, canonicalPath: string): Workspace {
  return {
    id: '',
    userId,
    canonicalPath,
    displayName: canonicalPath,
    lastUsedAt: null,
    archivedAt: null,
    missingSince: null,
  }
}
