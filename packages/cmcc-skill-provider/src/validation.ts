/**
 * 投影 catalog 校验。损坏/非法 catalog 返回 null(Provider 安全降级为空,不 crash Runtime)。
 */
import type { SkillInvocationPolicy } from './contract.js'

export interface ProjectionSkillRecord {
  id: string
  name: string
  description: string
  whenToUse?: string
  invocation: SkillInvocationPolicy
  version: string
  bodyFile: string
}

export interface ProjectionCatalogRecord {
  schemaVersion: number
  revision: string
  generatedAt: string
  skills: ProjectionSkillRecord[]
}

export const PROJECTION_SCHEMA_VERSION = 1
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const UUID_RE = /^[0-9a-fA-F-]{36}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function validBodyFile(value: unknown): value is string {
  return typeof value === 'string'
    && !value.startsWith('/')
    && !value.includes('..')
    && /^bodies\/[0-9a-fA-F-]{36}\.md$/.test(value)
}

function validInvocation(value: unknown): value is SkillInvocationPolicy {
  return isRecord(value) && typeof value.modelInvocable === 'boolean' && typeof value.userInvocable === 'boolean'
}

function validSkill(value: unknown): value is ProjectionSkillRecord {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || !UUID_RE.test(value.id)) return false
  if (typeof value.name !== 'string' || !SKILL_NAME_RE.test(value.name)) return false
  if (typeof value.description !== 'string') return false
  if (value.whenToUse !== undefined && typeof value.whenToUse !== 'string') return false
  if (!validInvocation(value.invocation)) return false
  if (typeof value.version !== 'string') return false
  if (!validBodyFile(value.bodyFile)) return false
  return true
}

/** 校验并返回 catalog;任一关键字段非法 → null(整份 catalog 不可信)。 */
export function validateCatalog(value: unknown): ProjectionCatalogRecord | null {
  if (!isRecord(value)) return null
  if (value.schemaVersion !== PROJECTION_SCHEMA_VERSION) return null
  if (typeof value.revision !== 'string' || value.revision === '') return null
  if (typeof value.generatedAt !== 'string') return null
  if (!Array.isArray(value.skills)) return null
  if (!value.skills.every(validSkill)) return null
  return value as unknown as ProjectionCatalogRecord
}
