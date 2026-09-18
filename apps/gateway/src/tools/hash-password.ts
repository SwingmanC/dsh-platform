import { hashPassword } from '../auth/password.js'

/**
 * 生成 argon2id 密码哈希,用于 t_dsh_users.password_hash 或本地改密。
 * 用法:pnpm --filter @dsh-platform/gateway hash-password <新密码>
 */
const password = process.argv[2]
if (password === undefined || password === '') {
  console.error('用法:pnpm --filter @dsh-platform/gateway hash-password <新密码>')
  process.exit(1)
}

const digest = await hashPassword(password)
console.log(digest)
