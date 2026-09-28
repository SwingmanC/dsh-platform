import type { UserRole, UserStatus } from '@dsh-platform/shared'
import { queryOne } from '../db.js'

export interface UserAuthState {
  tenantId: string
  displayName: string
  role: UserRole
  status: UserStatus
  authVersion: number
}

export async function loadUserAuthState(userId: string, readOne: typeof queryOne = queryOne): Promise<UserAuthState | null> {
  return await readOne<UserAuthState>(
    `SELECT tenant_id AS tenantId, display_name AS displayName, role, status,
            auth_version AS authVersion FROM t_dsh_users WHERE id = ? AND deleted_at IS NULL`, [userId],
  ) ?? null
}
