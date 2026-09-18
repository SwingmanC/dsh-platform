/**
 * Skill Runtime 投影(Gateway-owned derived projection)。
 *
 * 架构:
 *   Platform DB(authoritative)
 *     → Gateway 构建投影文件(derived artifact,atomic write)
 *     → DSH cmcc-skill-provider(只读消费,经 ctx.skills.registerProvider)
 *
 * 安全:
 * - 路径由服务端 principal 生成(tenantId/userId 来自认证会话),不接受请求体指定。
 * - tenantId/userId 必须是 UUID(防目录穿越)。
 * - 不含 Secret;body 为 Skill 的 prompt 文本(按不可信指令内容处理)。
 * - 投影目录不是业务 source of truth。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import { skillRepository } from './repositories/skill-repository.js'

/** DSH 0.1.5 skill name 语法(kebab-case)。 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const UUID_RE = /^[0-9a-fA-F-]{36}$/

export const PROJECTION_SCHEMA_VERSION = 1 as const

export interface ProjectionSkill {
  /** 稳定 locator(平台 skill id)。 */
  id: string
  /** Runtime kebab-case name(= 平台 slug)。 */
  name: string
  description: string
  whenToUse?: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  version: string
  /** 相对 body 文件(相对投影 skills 目录)。 */
  bodyFile: string
}

export interface ProjectionCatalog {
  schemaVersion: typeof PROJECTION_SCHEMA_VERSION
  revision: string
  generatedAt: string
  tenantId: string
  userId: string
  skills: ProjectionSkill[]
}

export interface InvalidSkill {
  id: string
  name: string
  reason: 'invalid-name' | 'missing-body' | 'name-collision'
}

export interface ProjectionBuildResult {
  revision: string
  skillCount: number
  invalid: InvalidSkill[]
  dir: string
}

export interface ProjectionStatus {
  state: 'CONNECTED' | 'SYNCING' | 'ERROR' | 'RUNTIME_STOPPED' | 'NOT_CONNECTED'
  desiredRevision: string | null
  observedRevision: string | null
  lastObservedAt: string | null
  error: string | null
  skillCount: number
  generatedAt: string | null
}

function safeSegment(value: string): string {
  if (!UUID_RE.test(value)) throw new Error(`unsafe projection path segment: ${value}`)
  return value
}

/** 该用户的投影目录(路径由 principal 生成)。 */
export function skillProjectionDir(tenantId: string, userId: string): string {
  return path.join(config.dsh.projectionsRoot, safeSegment(tenantId), safeSegment(userId), 'skills')
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, file)
}

function revisionOf(skills: ProjectionSkill[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ schemaVersion: PROJECTION_SCHEMA_VERSION, skills }))
    .digest('hex')
    .slice(0, 16)
}

/**
 * 构建某用户当前 Skill 投影。安装/卸载/publish/Runtime 启动时调用。
 * 无效记录(非法 name / 缺 body / name 冲突)被排除并结构化报告,不使整个 catalog 崩溃。
 */
export async function buildSkillProjection(tenantId: string, userId: string): Promise<ProjectionBuildResult> {
  const dir = skillProjectionDir(tenantId, userId)
  const rows = await skillRepository.listProjectableInstalled(userId)

  const invalid: InvalidSkill[] = []
  const byName = new Map<string, ProjectionSkill>()
  const bodies = new Map<string, string>()

  for (const row of rows) {
    const name = row.slug
    if (!SKILL_NAME_RE.test(name)) {
      invalid.push({ id: row.id, name, reason: 'invalid-name' })
      continue
    }
    const body = row.prompt ?? ''
    if (body.trim() === '') {
      invalid.push({ id: row.id, name, reason: 'missing-body' })
      continue
    }
    if (byName.has(name)) {
      // name 冲突:两个已安装 skill 映射到同一 runtime name。排除后者,保留先到者。
      invalid.push({ id: row.id, name, reason: 'name-collision' })
      continue
    }
    byName.set(name, {
      id: row.id,
      name,
      description: row.description ?? row.name,
      invocation: { modelInvocable: true, userInvocable: true },
      version: row.version,
      bodyFile: `bodies/${row.id}.md`,
    })
    bodies.set(row.id, body)
  }

  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  const revision = revisionOf(skills)

  await mkdir(path.join(dir, 'bodies'), { recursive: true })
  for (const [id, body] of bodies) {
    await atomicWrite(path.join(dir, 'bodies', `${id}.md`), body)
  }

  const catalog: ProjectionCatalog = {
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    revision,
    generatedAt: new Date().toISOString(),
    tenantId,
    userId,
    skills,
  }
  await atomicWrite(path.join(dir, 'catalog.json'), JSON.stringify(catalog, null, 2))
  // status.json 由 Gateway 拥有(desired);ack.json 由 Provider 写(observed)。
  await atomicWrite(path.join(dir, 'status.json'), JSON.stringify({
    desiredRevision: revision, generatedAt: catalog.generatedAt, skillCount: skills.length,
  }, null, 2))

  return { revision, skillCount: skills.length, invalid, dir }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

/**
 * 读取投影状态(真实 evidence,非文件存在推断)。
 * @param runtimeState - 该用户 Runtime 的 supervisor 进程状态(ready/starting/.../undefined=未运行)。
 */
export async function readSkillProjectionStatus(
  tenantId: string,
  userId: string,
  runtimeState: string | undefined,
): Promise<ProjectionStatus> {
  const dir = skillProjectionDir(tenantId, userId)
  const status = await readJson<{ desiredRevision: string; generatedAt: string; skillCount: number }>(path.join(dir, 'status.json'))
  const ack = await readJson<{ observedRevision: string; lastObservedAt: string; error?: string }>(path.join(dir, 'ack.json'))
  const desiredRevision = status?.desiredRevision ?? null
  const observedRevision = ack?.observedRevision ?? null

  let state: ProjectionStatus['state']
  if (runtimeState !== 'ready') state = 'RUNTIME_STOPPED'
  else if (typeof ack?.error === 'string' && ack.error !== '') state = 'ERROR'
  else if (desiredRevision === null) state = 'NOT_CONNECTED'
  else if (observedRevision === desiredRevision) state = 'CONNECTED'
  else state = 'SYNCING'

  return {
    state,
    desiredRevision,
    observedRevision,
    lastObservedAt: ack?.lastObservedAt ?? null,
    error: ack?.error ?? null,
    skillCount: status?.skillCount ?? 0,
    generatedAt: status?.generatedAt ?? null,
  }
}

/** publish/version 变更后,刷新所有真实安装者(不能只刷新 publisher 自己)。 */
export async function rebuildProjectionsForSkill(skillId: string): Promise<number> {
  const owners = await skillRepository.listInstallationOwners(skillId)
  let count = 0
  for (const owner of owners) {
    await buildSkillProjection(owner.tenantId, owner.userId)
    count += 1
  }
  return count
}
