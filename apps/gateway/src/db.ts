import mysql from 'mysql2/promise'

// 连接参数来自环境(根 .env.example);真实凭据不进版本库。
const host = process.env.MYSQL_HOST ?? '127.0.0.1'
const port = Number(process.env.MYSQL_PORT ?? 3306)
const user = process.env.MYSQL_USER ?? 'root'
const password = process.env.MYSQL_PASSWORD ?? ''
const database = process.env.MYSQL_DATABASE ?? 'dsh_platform'

export const pool = mysql.createPool({
  host,
  port,
  user,
  password,
  database,
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
