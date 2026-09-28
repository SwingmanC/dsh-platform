import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import mysql from 'mysql2/promise'
import { config } from '../src/config.js'
import { UserRepository } from '../src/repositories/user-repository.js'
import { UserManagementError } from '../src/services/user-validation.js'
import type { AuthenticatedPrincipal } from '@dsh-platform/shared'
import { loadUserAuthState } from '../src/auth/user-state.js'
import type { queryOne } from '../src/db.js'

// 明确启用时才连接本地数据库；只创建/删除此测试独占的临时库，不改业务库。
test('MySQL migration, tenant isolation, unique login, atomic role protection and revocation versions', { skip: process.env.USER_MANAGEMENT_MYSQL !== '1' }, async () => {
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(config.mysql.host), 'integration test only permits local MySQL')
  const scratch = `dsh_users_test_${process.pid}_${Date.now()}`
  const admin = mysql.createPool({ host: config.mysql.host, port: config.mysql.port, user: config.mysql.user, password: config.mysql.password })
  let db: mysql.Pool | undefined
  try {
    await admin.query(`CREATE DATABASE ${scratch} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`)
    db = mysql.createPool({ host: config.mysql.host, port: config.mysql.port, user: config.mysql.user, password: config.mysql.password, database: scratch, connectionLimit: 4 })
    const schema = await readFile(new URL('../../../db/schema.sql', import.meta.url), 'utf8')
    for (const table of ['t_dsh_tenants', 't_dsh_users', 't_dsh_workspaces']) {
      let ddl = schema.match(new RegExp(`CREATE TABLE ${table} \\([\\s\\S]*?\\) ENGINE=InnoDB[^;]*;`))![0]
      // Reconstruct previous schema, then run the real incremental migration.
      ddl = ddl.replace(/^.*auth_version.*\n/gm, '').replace(/^.*uk_users_email.*\n/gm, '').replace(/^.*deleted_at.*\n/gm, '')
      await db.query(ddl)
    }
    const migration = (await readFile(new URL('../../../db/migrations/012-user-management.sql', import.meta.url), 'utf8')).replaceAll('dsh_platform.', `${scratch}.`)
    await db.query(migration)
    await db.query((await readFile(new URL('../../../db/migrations/013-user-soft-delete.sql', import.meta.url), 'utf8')).replaceAll('dsh_platform.', `${scratch}.`))
    const a = randomUUID(), b = randomUUID(), aId = randomUUID(), bId = randomUUID()
    for (const [tenant, id, email] of [[a, aId, 'admin-a@example.test'], [b, bId, 'admin-b@example.test']]) {
      await db.execute('INSERT INTO t_dsh_tenants (id,slug,name,settings) VALUES (?,?,?,JSON_OBJECT())', [tenant, tenant, tenant])
      await db.execute("INSERT INTO t_dsh_users (id,tenant_id,email,display_name,role) VALUES (?,?,?,?,'tenant_admin')", [id, tenant, email, 'Admin'])
    }
    const actor = (tenantId: string, userId: string): AuthenticatedPrincipal => ({ tenantId, userId, displayName: 'Admin', role: 'tenant_admin', authVersion: 0, sessionId: 'test', deviceId: 'test' })
    const actorA = actor(a, aId), actorB = actor(b, bId)
    const repo = new UserRepository(db)
    const member = await repo.create(actorA, { email: 'member@example.test', displayName: 'Member', role: 'member' }, 'hash-fixture')
    assert.doesNotMatch(JSON.stringify(member), /hash-fixture|authVersion|password/)
    assert.equal((await repo.list(a, { page: 1, pageSize: 20 })).total, 2)
    assert.equal((await repo.list(a, { q: 'member@', page: 1, pageSize: 20 })).users[0]?.id, member.id)
    assert.equal((await repo.list(a, { q: '%', page: 1, pageSize: 20 })).total, 0)
    await assert.rejects(() => repo.update(actorB, member.id, { status: 'disabled' }), (e: unknown) => e instanceof UserManagementError && e.statusCode === 404)
    await assert.rejects(() => repo.update(actorA, aId, { role: 'member' }), /cannot-disable-or-demote-self/)
    await assert.rejects(() => repo.create(actorB, { email: member.email, displayName: 'Duplicate', role: 'member' }, 'hash'), /email-unavailable/)
    assert.equal((await repo.list(b, { page: 1, pageSize: 20 })).total, 1)
    await repo.update(actorA, member.id, { displayName: 'Renamed' })
    let [rows] = await db.query<mysql.RowDataPacket[]>('SELECT auth_version FROM t_dsh_users WHERE id=?', [member.id])
    assert.equal(rows[0]?.auth_version, 0)
    await repo.update(actorA, member.id, { status: 'disabled' })
    await repo.update(actorA, member.id, {}, 'new-hash')
    ;[rows] = await db.query<mysql.RowDataPacket[]>('SELECT auth_version FROM t_dsh_users WHERE id=?', [member.id])
    assert.equal(rows[0]?.auth_version, 2)
    const workspaceId = randomUUID()
    await db.execute('INSERT INTO t_dsh_workspaces (id,user_id,canonical_path,display_name) VALUES (?,?,?,?)', [workspaceId, member.id, '/test/retained-workspace', 'Historical asset'])
    await assert.rejects(() => repo.remove(actorB, member.id), /not-found/)
    await assert.rejects(() => repo.remove(actorA, aId), /cannot-delete-self/)
    await repo.remove(actorA, member.id)
    ;[rows] = await db.query<mysql.RowDataPacket[]>('SELECT auth_version, status, deleted_at FROM t_dsh_users WHERE id=?', [member.id])
    assert.equal(rows[0]?.auth_version, 3)
    assert.equal(rows[0]?.status, 'disabled')
    assert.ok(rows[0]?.deleted_at)
    const [assets] = await db.query<mysql.RowDataPacket[]>('SELECT id FROM t_dsh_workspaces WHERE user_id=?', [member.id])
    assert.equal(assets[0]?.id, workspaceId)
    assert.equal((await repo.list(a, { page: 1, pageSize: 20, q: member.email })).total, 0)
    assert.equal((await repo.list(a, { page: 1, pageSize: 20, status: 'disabled' })).total, 0)
    await assert.rejects(() => repo.update(actorA, member.id, { status: 'active' }), /not-found/)
    await assert.rejects(() => repo.update(actorA, member.id, {}, 'reset-hash'), /not-found/)
    await assert.rejects(() => repo.remove(actorA, member.id), /not-found/)
    await assert.rejects(() => repo.create(actorA, { email: member.email, displayName: 'Reused', role: 'member' }, 'hash'), /email-unavailable/)
    const readOne: typeof queryOne = async <T>(sql: string, params: Parameters<typeof queryOne>[1] = []) => {
      const [result] = await db!.query<mysql.RowDataPacket[]>(sql, params)
      return result[0] as T | undefined
    }
    // 即使状态被外部维护误改成 active，deleted_at 仍独立阻断认证和 runtime 启动。
    await db.execute("UPDATE t_dsh_users SET status='active' WHERE id=?", [member.id])
    assert.equal(await loadUserAuthState(member.id, readOne), null)
    assert.notEqual(await loadUserAuthState(aId, readOne), null)
    // Cross-tenant concurrent creates cannot race past the unique index.
    const race = await Promise.allSettled([actorA, actorB].map((who) => repo.create(who, { email: 'race@example.test', displayName: 'Race', role: 'member' }, 'hash')))
    assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1)
    const second = await repo.create(actorA, { email: 'second-admin@example.test', displayName: 'Second admin', role: 'tenant_admin' }, 'hash')
    const actor2 = actor(a, second.id)
    const demotions = await Promise.allSettled([repo.update(actorA, second.id, { role: 'member' }), repo.update(actor2, aId, { role: 'member' })])
    assert.equal(demotions.filter((r) => r.status === 'fulfilled').length, 1)
    const remaining = await repo.list(a, { page: 1, pageSize: 20, role: 'tenant_admin', status: 'active' })
    assert.equal(remaining.total, 1)
    const survivor = actor(a, remaining.users[0]!.id)
    const otherAdmin = await repo.create(survivor, { email: 'delete-admin@example.test', displayName: 'Other admin', role: 'tenant_admin' }, 'hash')
    const deletions = await Promise.allSettled([repo.remove(survivor, otherAdmin.id), repo.remove(actor(a, otherAdmin.id), survivor.userId)])
    assert.equal(deletions.filter((r) => r.status === 'fulfilled').length, 1)
    assert.equal((await repo.list(a, { page: 1, pageSize: 20, role: 'tenant_admin', status: 'active' })).total, 1)
  } finally {
    await db?.end()
    await admin.query(`DROP DATABASE IF EXISTS ${scratch}`)
    await admin.end()
  }
})
