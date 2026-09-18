import { hash, verify } from '@node-rs/argon2'

/**
 * 密码哈希(platform 设计 §3.1):argon2id。
 * 参数与 @node-rs/argon2 默认一致(m=19456 KiB,t=2,p=1),产物形如
 * `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<digest>`。
 */
export function hashPassword(plain: string): Promise<string> {
  return hash(plain)
}

/** 恒定时间校验由底层实现保证;哈希格式非法时返回 false 而非抛错。 */
export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain)
  } catch {
    return false
  }
}
