import mysql from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2/promise'
import { config } from './config.js'

/** 可安全绑定到预处理语句/查询的参数类型。 */
export type SqlValue = string | number | bigint | boolean | Date | Buffer | Uint8Array | null

// 连接参数来自环境(根 .env);真实凭据不进版本库。
export const pool = mysql.createPool({
  host: config.mysql.host,
  port: config.mysql.port,
  user: config.mysql.user,
  password: config.mysql.password,
  database: config.mysql.database,
  connectionLimit: 10,
  charset: 'utf8mb4',
  // DATETIME(3) 以字符串原样返回,毫秒精度在 JSON 往返中不丢失。
  dateStrings: true,
})

/** GET /api/health 的存活探测。 */
export async function ping(): Promise<boolean> {
  try {
    await pool.query('SELECT 1')
    return true
  } catch {
    return false
  }
}

/** 多行查询。 */
export async function queryMany<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
  const [rows] = await pool.query<RowDataPacket[]>(sql, params)
  return rows as T[]
}

/** 单行查询,返回 T 或 undefined。 */
export async function queryOne<T>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
  const rows = await queryMany<T>(sql, params)
  return rows[0]
}

/** 写操作,返回 affectedRows。 */
export async function execute(sql: string, params: SqlValue[] = []): Promise<number> {
  const [result] = await pool.execute(sql, params)
  return (result as { affectedRows?: number }).affectedRows ?? 0
}
