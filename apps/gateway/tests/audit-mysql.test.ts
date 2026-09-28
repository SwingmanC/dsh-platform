import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import mysql from 'mysql2/promise'
import { config } from '../src/config.js'
import { AuditRepository, type StoredAuditEvent } from '../src/repositories/audit-repository.js'
import { AuditService } from '../src/services/audit-service.js'
import type { SqlValue } from '../src/db.js'

// Isolated scratch database only; never applies migrations to the business database.
test('MySQL audit migration, legacy rows, tenant isolation, stable pagination and bigint IDs', { skip: process.env.AUDIT_MYSQL !== '1' }, async () => {
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(config.mysql.host), 'test only permits local MySQL')
  const scratch = `dsh_audit_test_${process.pid}_${Date.now()}`
  const connection = await mysql.createConnection({ host: config.mysql.host, port: config.mysql.port, user: config.mysql.user, password: config.mysql.password,
    dateStrings: true, supportBigNumbers: true, bigNumberStrings: true })
  try {
    await connection.query(`CREATE DATABASE ${scratch} CHARACTER SET utf8mb4`)
    await connection.query(`USE ${scratch}`)
    await connection.query(`CREATE TABLE t_dsh_audit_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, tenant_id CHAR(36), actor CHAR(36),
      action VARCHAR(64) NOT NULL, subject VARCHAR(256), payload JSON,
      at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), KEY idx_audit_tenant_time (tenant_id, at)
    ) ENGINE=InnoDB`)
    await connection.execute("INSERT INTO t_dsh_audit_events (tenant_id,action,payload) VALUES ('tenant-a','login',?)",
      [JSON.stringify({ password: 'legacy-secret', content: 'private-body', role: 'member' })])
    const migration = (await readFile(new URL('../../../db/migrations/014-audit-log.sql', import.meta.url), 'utf8')).replaceAll('dsh_platform.', `${scratch}.`)
    await connection.query(migration)
    const schema = await readFile(new URL('../../../db/schema.sql', import.meta.url), 'utf8')
    const freshDdl = schema.match(/CREATE TABLE t_dsh_audit_events \([\s\S]*?\) ENGINE=InnoDB[^;]*;/)![0]
      .replace('CREATE TABLE t_dsh_audit_events', 'CREATE TABLE fresh_audit')
    await connection.query(freshDdl)
    const [upgradedColumns] = await connection.query<mysql.RowDataPacket[]>('SHOW COLUMNS FROM t_dsh_audit_events')
    const [freshColumns] = await connection.query<mysql.RowDataPacket[]>('SHOW COLUMNS FROM fresh_audit')
    assert.deepEqual(upgradedColumns, freshColumns)
    const [upgradedIndexes] = await connection.query<mysql.RowDataPacket[]>('SHOW INDEX FROM t_dsh_audit_events')
    const [freshIndexes] = await connection.query<mysql.RowDataPacket[]>('SHOW INDEX FROM fresh_audit')
    const signature = (rows: mysql.RowDataPacket[]) => rows.map((r) => [r.Key_name, r.Seq_in_index, r.Column_name, r.Non_unique])
    assert.deepEqual(signature(upgradedIndexes), signature(freshIndexes))
    const writer = async (sql: string, params: SqlValue[] = []) => {
      const [result] = await connection.execute<mysql.ResultSetHeader>(sql, params)
      return result.affectedRows
    }
    const reader = async <T>(sql: string, params: SqlValue[] = []): Promise<T[]> => {
      const [rows] = await connection.query<mysql.RowDataPacket[]>(sql, params)
      return rows as T[]
    }
    const repository = new AuditRepository(writer, reader)
    const service = new AuditService(repository, () => {})
    await service.write({ action: 'user.create', identity: { tenantId: 'tenant-a', userId: 'actor-a', displayName: '管理员甲' }, resourceId: 'target-a', payload: { role: 'member', password: 'new-secret' } })
    await service.write({ action: 'user.delete', identity: { tenantId: 'tenant-b', userId: 'actor-b' }, result: 'DENIED', resourceId: 'target-b' })
    await service.write({ action: 'login.failed', result: 'DENIED' })
    assert.equal(service.failures, 0)
    // Force identical times to exercise the ID tie-breaker.
    await connection.execute("UPDATE t_dsh_audit_events SET at='2026-09-28 01:02:03.456'")
    const a = await repository.list('tenant-a', { page: 1, pageSize: 1 })
    const next = await repository.list('tenant-a', { page: 2, pageSize: 1 })
    assert.equal(a.total, 2); assert.equal(a.items[0]?.action, 'user.create'); assert.equal(next.items[0]?.result, null)
    assert.equal(a.items[0]?.at, '2026-09-28T01:02:03.456000Z')
    assert.doesNotMatch(JSON.stringify(next), /legacy-secret|private-body/)
    assert.equal(await repository.find('tenant-a', '3'), null)
    assert.equal(await repository.find('tenant-a', '4'), null)
    assert.equal((await repository.list('tenant-b', {})).total, 1)
    assert.equal((await repository.list('tenant-a', { actorName: '管理员', result: 'SUCCESS', action: 'user.create', from: '2026-09-28T01:00:00.000Z', to: '2026-09-28T02:00:00.000Z' })).total, 1)
    assert.equal((await repository.list('tenant-a', { actorName: '%' })).total, 0)
    const event: StoredAuditEvent = { tenantId: 'tenant-a', actor: 'actor-a', actorName: 'Admin snapshot', action: 'user.delete', resourceType: 'user', resourceId: 'deleted-user',
      subject: null, result: 'SUCCESS', reasonCode: null, requestId: null, clientIp: null, userAgent: null, source: 'system', payload: null }
    await connection.query('ALTER TABLE t_dsh_audit_events AUTO_INCREMENT = 9007199254740993')
    await repository.insert(event)
    assert.equal((await repository.find('tenant-a', '9007199254740993'))?.id, '9007199254740993')
    assert.equal((await repository.find('tenant-a', '9007199254740993'))?.actorName, 'Admin snapshot')
    // Verified UTC+8 legacy boundary: correction is repeatable and preserves metadata/new rows.
    for (const id of [17, 23, 28, 29]) {
      await connection.execute("INSERT INTO t_dsh_audit_events (id,tenant_id,actor,action,subject,payload,at) VALUES (?, 'tenant-a', 'actor-a', 'user.create', 'target', JSON_OBJECT('role','member'), '2026-09-28 14:08:56.352')", [id])
    }
    const [beforeRepair] = await connection.query<mysql.RowDataPacket[]>('SELECT * FROM t_dsh_audit_events ORDER BY id')
    const repair = (await readFile(new URL('../../../db/migrations/015-audit-legacy-time-utc.sql', import.meta.url), 'utf8')).replaceAll('dsh_platform.', `${scratch}.`)
    const statements = repair.replace(/^--.*$/gm, '').split(';').map((v) => v.trim()).filter(Boolean)
    for (const sql of statements) await connection.query(sql)
    const [repaired] = await connection.query<mysql.RowDataPacket[]>('SELECT * FROM t_dsh_audit_events ORDER BY id')
    for (let i = 0; i < repaired.length; i++) {
      const { at: oldTime, ...oldMetadata } = beforeRepair[i]!
      const { at: newTime, ...newMetadata } = repaired[i]!
      assert.deepEqual(newMetadata, oldMetadata)
      if (Number(repaired[i]!.id) <= 28 && repaired[i]!.source === null) {
        assert.equal(Date.parse(newTime.replace(' ', 'T') + 'Z'), Date.parse(oldTime.replace(' ', 'T') + 'Z') - 8 * 3600000)
      } else assert.equal(newTime, oldTime)
    }
    for (const sql of statements) await connection.query(sql)
    const [repeated] = await connection.query<mysql.RowDataPacket[]>('SELECT * FROM t_dsh_audit_events ORDER BY id')
    assert.deepEqual(repeated, repaired)
    const [backup] = await connection.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS total FROM t_dsh_audit_time_corrections')
    assert.equal(Number(backup[0]?.total), 4)

  } finally {
    await connection.query(`DROP DATABASE IF EXISTS ${scratch}`)
    await connection.end()
  }
})
