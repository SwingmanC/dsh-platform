import { randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { AuthenticatedPrincipal, CreateUserInput, ManagedUser, UpdateUserInput, UserListQuery, UserListResponse } from '@dsh-platform/shared'
import { pool } from '../db.js'
import { UserManagementError } from '../services/user-validation.js'

const COLUMNS = `id, email, display_name AS displayName, role, status,
  DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS createdAt`

interface UserRow extends RowDataPacket, ManagedUser { authVersion: number }

export interface UserChange {
  user: ManagedUser
  securityChanged: boolean
  changedFields: string[]
}

export class UserRepository {
  constructor(private readonly db: Pool = pool) {}

  async list(tenantId: string, q: UserListQuery & { page: number; pageSize: number }): Promise<UserListResponse> {
    const where = ['tenant_id = ?', 'deleted_at IS NULL']
    const values: (string | number)[] = [tenantId]
    if (q.q) {
      // LOCATE 实现字面包含检索，%/_ 不会被当成通配符。
      where.push('(LOCATE(?, display_name) > 0 OR LOCATE(?, email) > 0)')
      values.push(q.q, q.q)
    }
    if (q.role) { where.push('role = ?'); values.push(q.role) }
    if (q.status) { where.push('status = ?'); values.push(q.status) }
    const predicate = where.join(' AND ')
    const [counts] = await this.db.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM t_dsh_users WHERE ${predicate}`, values)
    const [users] = await this.db.query<UserRow[]>(
      `SELECT ${COLUMNS} FROM t_dsh_users WHERE ${predicate} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...values, q.pageSize, (q.page - 1) * q.pageSize],
    )
    return { users, total: Number(counts[0]?.total ?? 0), page: q.page, pageSize: q.pageSize }
  }

  /** 租户行锁串行化人员安全变更；最后管理员检查与更新使用同一事务。 */
  private async transaction<T>(actor: AuthenticatedPrincipal, work: (conn: PoolConnection) => Promise<T>): Promise<T> {
    const conn = await this.db.getConnection()
    try {
      await conn.beginTransaction()
      await conn.query('SELECT id FROM t_dsh_tenants WHERE id = ? FOR UPDATE', [actor.tenantId])
      const [actors] = await conn.query<RowDataPacket[]>(
        'SELECT role, status, auth_version AS authVersion FROM t_dsh_users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL FOR UPDATE',
        [actor.userId, actor.tenantId],
      )
      const current = actors[0]
      if (!current || current.role !== 'tenant_admin' || current.status !== 'active'
        || current.authVersion !== actor.authVersion) throw new UserManagementError(401, 'unauthenticated')
      const result = await work(conn)
      await conn.commit()
      return result
    } catch (err) {
      await conn.rollback()
      if ((err as { code?: string }).code === 'ER_DUP_ENTRY') throw new UserManagementError(409, 'email-unavailable')
      throw err
    } finally { conn.release() }
  }

  private async find(conn: PoolConnection, tenantId: string, id: string): Promise<UserRow> {
    const [rows] = await conn.query<UserRow[]>(
      `SELECT ${COLUMNS}, auth_version AS authVersion FROM t_dsh_users WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE`, [tenantId, id],
    )
    if (!rows[0]) throw new UserManagementError(404, 'not-found')
    return rows[0]
  }

  private publicUser(row: UserRow): ManagedUser {
    const { authVersion: _version, ...user } = row
    return user
  }

  private async requireAnotherAdmin(conn: PoolConnection, tenantId: string): Promise<void> {
    const [admins] = await conn.query<RowDataPacket[]>(
      "SELECT id FROM t_dsh_users WHERE tenant_id = ? AND role = 'tenant_admin' AND status = 'active' AND deleted_at IS NULL FOR UPDATE", [tenantId],
    )
    if (admins.length <= 1) throw new UserManagementError(409, 'last-tenant-admin')
  }

  async remove(actor: AuthenticatedPrincipal, id: string): Promise<void> {
    await this.transaction(actor, async (conn) => {
      const target = await this.find(conn, actor.tenantId, id)
      if (id === actor.userId) throw new UserManagementError(409, 'cannot-delete-self')
      if (target.role === 'tenant_admin' && target.status === 'active') await this.requireAnotherAdmin(conn, actor.tenantId)
      await conn.execute(`UPDATE t_dsh_users SET deleted_at = UTC_TIMESTAMP(3), status = 'disabled',
        auth_version = auth_version + 1 WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`, [actor.tenantId, id])
    })
  }

  async create(actor: AuthenticatedPrincipal, input: Omit<CreateUserInput, 'password'>, passwordHash: string): Promise<ManagedUser> {
    return this.transaction(actor, async (conn) => {
      const id = randomUUID()
      await conn.execute(`INSERT INTO t_dsh_users
        (id, tenant_id, email, display_name, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', UTC_TIMESTAMP(3))`,
      [id, actor.tenantId, input.email, input.displayName, passwordHash, input.role])
      return this.publicUser(await this.find(conn, actor.tenantId, id))
    })
  }

  async update(actor: AuthenticatedPrincipal, id: string, input: UpdateUserInput, passwordHash?: string): Promise<UserChange> {
    return this.transaction(actor, async (conn) => {
      const before = await this.find(conn, actor.tenantId, id)
      const after = { ...before, ...input }
      if (id === actor.userId && (after.role !== 'tenant_admin' || after.status !== 'active')) {
        throw new UserManagementError(409, 'cannot-disable-or-demote-self')
      }
      if (before.role === 'tenant_admin' && before.status === 'active'
        && (after.role !== 'tenant_admin' || after.status !== 'active')) {
        await this.requireAnotherAdmin(conn, actor.tenantId)
      }
      const changedFields: string[] = (Object.keys(input) as Array<keyof UpdateUserInput>).filter((key) => before[key] !== after[key])
      if (passwordHash !== undefined) changedFields.push('password')
      const securityChanged = passwordHash !== undefined || after.role !== before.role
        || after.status !== before.status || after.email !== before.email
      const values: (string | number)[] = [after.email, after.displayName, after.role, after.status, securityChanged ? 1 : 0]
      const passwordSql = passwordHash === undefined ? '' : ', password_hash = ?'
      if (passwordHash !== undefined) values.push(passwordHash)
      values.push(actor.tenantId, id)
      await conn.execute(`UPDATE t_dsh_users SET email = ?, display_name = ?, role = ?, status = ?,
        auth_version = auth_version + ?${passwordSql} WHERE tenant_id = ? AND id = ?`, values)
      return { user: this.publicUser(await this.find(conn, actor.tenantId, id)), securityChanged, changedFields }
    })
  }
}

export const userRepository = new UserRepository()
