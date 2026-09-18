/**
 * CredentialStore —— 服务端 credential 加密抽象(AES-256-GCM)。
 *
 * 设计:
 * - 版本化自描述 envelope:`v1.<iv-b64url>.<tag-b64url>.<ciphertext-b64url>`
 * - master key 仅从进程 env `PLATFORM_SECRET_ENCRYPTION_KEY` 获取(32 字节,hex/base64)
 * - 绝不落盘明文;DB 只存 envelope;日志/audit/API 不返回明文
 *
 * 该 envelope 存入现有 `t_dsh_mcp_credentials.ciphertext` (VARBINARY) 列,
 * 无需 schema 变更;版本号支持未来算法轮换。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const KEY_BYTES = 32
const VERSION = 'v1'

export class CredentialStoreError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CredentialStoreError'
  }
}

function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim()
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex')
  const buf = Buffer.from(trimmed, 'base64')
  if (buf.length === KEY_BYTES) return buf
  throw new CredentialStoreError('invalid-encryption-key')
}

export class CredentialStore {
  private readonly key: Buffer

  constructor(keyMaterial: string) {
    if (keyMaterial === '') throw new CredentialStoreError('missing-encryption-key')
    this.key = decodeKey(keyMaterial)
    if (this.key.length !== KEY_BYTES) throw new CredentialStoreError('invalid-encryption-key')
  }

  /** 加密明文 → 版本化 envelope 字符串。 */
  seal(plaintext: string): string {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGORITHM, this.key, iv)
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.')
  }

  /** 解密 envelope → 明文。篡改/版本不支持抛 CredentialStoreError。 */
  open(envelope: string): string {
    const parts = envelope.split('.')
    if (parts.length !== 4 || parts[0] !== VERSION) throw new CredentialStoreError('invalid-envelope')
    const iv = Buffer.from(parts[1] as string, 'base64url')
    const tag = Buffer.from(parts[2] as string, 'base64url')
    const ct = Buffer.from(parts[3] as string, 'base64url')
    if (iv.length !== IV_BYTES || tag.length !== 16) throw new CredentialStoreError('invalid-envelope')
    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
    } catch {
      throw new CredentialStoreError('decrypt-failed')
    }
  }
}

let singleton: CredentialStore | null = null

/** 从 env 延迟初始化单例(未配置 key 时抛错,调用方决定降级)。 */
export function getCredentialStore(): CredentialStore {
  if (singleton === null) {
    singleton = new CredentialStore(process.env.PLATFORM_SECRET_ENCRYPTION_KEY ?? '')
  }
  return singleton
}
