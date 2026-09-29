/**
 * K-T7 → SKILL-V1.2:SKILL.md 兼容层(DSH 0.1.5-rc.2 dsh-skill-filesystem 格式)。
 *
 * - Platform canonical model: { name, description, whenToUse?, modelInvocable, userInvocable, prompt }
 * - 映射:modelInvocable ↔ !disable-model-invocation;userInvocable ↔ user-invocable
 * - SKILL.md 是序列化格式,不是第二套业务模型(平台 DB 字段仍是唯一真实源)
 * - 安全:长度上限;仅接受 DSH 实际布尔形态(true/false/1/0/yes/no/on/off,大小写不敏感),
 *   其他值 → 拒绝整份(与 DSH 行为一致);拒绝 camelCase legacy 键;无 YAML 依赖/无代码执行
 */

export interface SkillMdCanonical {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  prompt: string
}

export const SKILL_MD_MAX_CHARS = 512 * 1024
export const SKILL_MD_MAX_NAME = 128
export const SKILL_MD_MAX_DESCRIPTION = 4096
export const SKILL_MD_MAX_WHEN_TO_USE = 512

export class SkillMdFormatError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'SkillMdFormatError'
  }
}

interface FrontmatterFields {
  name?: string
  description?: string
  whenToUse?: string
  'disable-model-invocation'?: unknown
  'user-invocable'?: unknown
}

/** 与 DSH frontmatterBoolean 一致:缺失 → undefined;合法形态归一;非法 → 抛错。 */
function frontmatterBoolean(data: FrontmatterFields, key: 'disable-model-invocation' | 'user-invocable'): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = (data as Record<string, unknown>)[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch ((value as string).toLowerCase()) {
      case 'true': case 'yes': case 'on': return true
      case 'false': case 'no': case 'off': return false
    }
  }
  throw new SkillMdFormatError(`invalid-boolean:${key}`)
}

/** camelCase legacy 键显式拒绝(与 DSH parseInvocationPolicy 行为一致)。 */
function rejectLegacyKey(data: Record<string, unknown>, legacy: string, canonical: string): void {
  if (Object.hasOwn(data, legacy)) {
    throw new SkillMdFormatError(`legacy-frontmatter-key:${legacy}`)
  }
}

/** 提取并解析 frontmatter 行(仅标量 key: value;拒绝 legacy camelCase 键)。 */
function parseFrontmatterLines(block: string): FrontmatterFields {
  const fields: Record<string, string> = {}
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trimEnd()
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx <= 0) throw new SkillMdFormatError('malformed-frontmatter')
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    fields[key] = value
  }
  rejectLegacyKey(fields, 'disableModelInvocation', 'disable-model-invocation')
  rejectLegacyKey(fields, 'modelInvocable', 'disable-model-invocation')
  rejectLegacyKey(fields, 'userInvocable', 'user-invocable')
  return fields as FrontmatterFields
}

function stringField(fields: FrontmatterFields, key: keyof FrontmatterFields, max: number, code: string): string | undefined {
  const v: unknown = fields[key]
  if (typeof v !== 'string' || v === '') return undefined
  const unquoted = stripQuotes(v)
  if (unquoted.length > max) throw new SkillMdFormatError(code)
  return unquoted
}

function stripQuotes(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1)
  }
  return v
}

/** 解析 SKILL.md → canonical;任何不合法 → SkillMdFormatError(受控码)。 */
export function parseSkillMd(text: string): SkillMdCanonical {
  if (typeof text !== 'string' || text.length > SKILL_MD_MAX_CHARS) {
    throw new SkillMdFormatError('skill-md-too-large')
  }
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) throw new SkillMdFormatError('malformed-frontmatter')
  const close = normalized.indexOf('\n---', 4)
  if (close === -1) throw new SkillMdFormatError('malformed-frontmatter')
  const fields = parseFrontmatterLines(normalized.slice(4, close))
  const body = normalized.slice(close + 4).replace(/^\n+/, '').trimEnd()

  const name = stringField(fields, 'name', SKILL_MD_MAX_NAME, 'name-too-large')
  if (name === undefined) throw new SkillMdFormatError('missing-name')
  const description = stringField(fields, 'description', SKILL_MD_MAX_DESCRIPTION, 'description-too-large')
  if (description === undefined) throw new SkillMdFormatError('missing-description')
  const whenToUse = stringField(fields, 'whenToUse', SKILL_MD_MAX_WHEN_TO_USE, 'when-to-use-too-large')

  const disableModelInvocation = frontmatterBoolean(fields, 'disable-model-invocation')
  const userInvocable = frontmatterBoolean(fields, 'user-invocable')

  return {
    name,
    description,
    ...(whenToUse !== undefined ? { whenToUse } : {}),
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
    prompt: body,
  }
}

/** canonical → SKILL.md(DSH 兼容序列化;与 parseSkillMd 语义互逆)。 */
export function serializeSkillMd(skill: SkillMdCanonical): string {
  const lines: string[] = ['---']
  lines.push(`name: ${yamlScalar(skill.name)}`)
  lines.push(`description: ${yamlScalar(skill.description)}`)
  if (skill.whenToUse !== undefined && skill.whenToUse !== '') {
    lines.push(`whenToUse: ${yamlScalar(skill.whenToUse)}`)
  }
  // DSH 语义:键缺省 = 允许;仅在禁用时写出键
  if (skill.modelInvocable === false) lines.push('disable-model-invocation: true')
  if (skill.userInvocable === false) lines.push('user-invocable: false')
  lines.push('---')
  return `${lines.join('\n')}\n\n${skill.prompt}`
}

function yamlScalar(v: string): string {
  const escaped = v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `"${escaped}"`
}
