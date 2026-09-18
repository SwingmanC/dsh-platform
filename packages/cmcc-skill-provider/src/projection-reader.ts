/**
 * 投影读取 + 官方 SkillProvider 实现。
 *
 * Provider 不缓存 body 为 authoritative state:每次 get() 重新读取当前投影。
 * 无效/缺失记录安全返回 undefined(不 crash)。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { CMCC_PLATFORM_SKILL_RANK } from './contract.js'
import type {
  SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProvider, SkillProviderControl,
} from './contract.js'
import { validateCatalog } from './validation.js'
import type { ProjectionCatalogRecord } from './validation.js'

const UUID_RE = /^[0-9a-fA-F-]{36}$/

export async function readCatalog(dir: string, signal?: AbortSignal): Promise<ProjectionCatalogRecord | null> {
  if (signal?.aborted === true) return null
  try {
    const raw = await readFile(path.join(dir, 'catalog.json'), 'utf8')
    return validateCatalog(JSON.parse(raw))
  } catch {
    return null
  }
}

export async function readBody(dir: string, id: string, signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted === true) return null
  if (!UUID_RE.test(id)) return null
  try {
    return await readFile(path.join(dir, 'bodies', `${id}.md`), 'utf8')
  } catch {
    return null
  }
}

async function writeAck(dir: string, revision: string, error: string | null): Promise<void> {
  const file = path.join(dir, 'ack.json')
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    const { writeFile, rename } = await import('node:fs/promises')
    await writeFile(tmp, JSON.stringify({
      observedRevision: revision, lastObservedAt: new Date().toISOString(), error,
    }, null, 2), 'utf8')
    await rename(tmp, file)
  } catch {
    // ack 写入失败不影响 provider 行为。
  }
}

/** 平台投影 Provider(name = `cmcc-platform`)。 */
export class ProjectionSkillProvider implements SkillProvider {
  readonly name = 'cmcc-platform'

  constructor(
    private readonly dir: string,
    private readonly control: SkillProviderControl,
  ) {}

  async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
    const catalog = await readCatalog(this.dir, options.signal)
    if (catalog === null) {
      await writeAck(this.dir, '', 'catalog-unavailable')
      return []
    }
    await writeAck(this.dir, catalog.revision, null)
    return catalog.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
      invocation: skill.invocation,
      source: 'custom' as const,
      provider: this.name,
      rank: CMCC_PLATFORM_SKILL_RANK,
      locator: { id: skill.id, version: skill.version },
      metadata: { platformSkillId: skill.id, platformVersion: skill.version },
    }))
  }

  async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    const locator = candidate.locator as { id?: unknown } | null
    const id = locator !== null && typeof locator === 'object' ? locator.id : undefined
    if (typeof id !== 'string') return undefined
    const content = await readBody(this.dir, id, options.signal)
    if (content === null) return undefined
    return {
      name: candidate.name,
      description: candidate.description,
      ...(candidate.whenToUse !== undefined ? { whenToUse: candidate.whenToUse } : {}),
      invocation: candidate.invocation,
      source: candidate.source,
      provider: candidate.provider,
      // §22:平台 DB 文本不伪造磁盘目录;资源基座为 opaque。
      resourceBase: { kind: 'opaque', description: 'cmcc-platform projection (no resources)' },
      content,
      metadata: { platformSkillId: id },
    }
  }
}
