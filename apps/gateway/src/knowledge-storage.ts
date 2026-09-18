import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'

const UUID_RE = /^[0-9a-fA-F-]{36}$/

function safeSegment(value: string): string {
  if (!UUID_RE.test(value)) throw new Error(`unsafe storage path segment: ${value}`)
  return value
}

export function documentStorageDir(tenantId: string, kbId: string, docId: string): string {
  return path.join(config.knowledge.storageRoot, safeSegment(tenantId), safeSegment(kbId), safeSegment(docId))
}

export interface StoredDocument {
  docId: string
  versionId: string
  contentHash: string
  bytes: number
  mime: string
  originalFilename: string
}

export async function storeUploadedDocument(
  tenantId: string, kbId: string, docId: string, buffer: Buffer, mime: string, originalFilename: string,
): Promise<StoredDocument> {
  const versionId = randomUUID()
  const contentHash = createHash('sha256').update(buffer).digest('hex')
  const dir = documentStorageDir(tenantId, kbId, docId)
  const versionDir = path.join(dir, versionId)
  await mkdir(versionDir, { recursive: true })
  const target = path.join(versionDir, 'source.bin')
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, buffer)
  await rename(tmp, target)
  return { docId, versionId, contentHash, bytes: buffer.length, mime, originalFilename }
}

export async function readStoredDocument(tenantId: string, kbId: string, docId: string, versionId: string): Promise<Buffer | null> {
  try {
    return await readFile(path.join(documentStorageDir(tenantId, kbId, docId), versionId, 'source.bin'))
  } catch {
    return null
  }
}