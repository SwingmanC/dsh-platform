/**
 * Memory 自动提取(确定性、保守优先)。
 *
 * 纪律:
 * - CONSERVATIVE_EXPLICIT_ONLY:只处理显式 remember 语义的用户陈述。
 * - 不存储 secret / 敏感个人资料(AUTO_EXTRACTION = DENY)。
 * - 不依赖 LLM;确定性可测。
 * - 永远先进入 personal/private(由 service 层固定)。
 */

export type MemoryKind = 'preference' | 'fact' | 'decision' | 'instruction' | 'other'

/** 显式 remember 语义(中英)。捕获组 1 = 待记忆内容。 */
const EXPLICIT_PATTERNS: ReadonlyArray<{ re: RegExp; kind: MemoryKind }> = [
  { re: /(?:请记住|帮我记住|请记下|记住|记下)[:：,,\s]*(.+)/i, kind: 'fact' },
  { re: /(?:please remember|remember that|note that|keep in mind that)[:：,,\s]*(.+)/i, kind: 'fact' },
  { re: /(?:以后都|今后都|之后都|从现在起|一律|统一)(.+)/i, kind: 'instruction' },
  { re: /(?:from now on|always|whenever)[:：,,\s]*(.+)/i, kind: 'instruction' },
  { re: /(?:我的偏好是|我偏好|我喜欢|我习惯)(.+)/i, kind: 'preference' },
  { re: /(?:my preference is|i prefer|i like)[:：,,\s]*(.+)/i, kind: 'preference' },
  { re: /(?:我们决定|决定采用|确定使用|这个项目(?:以后)?统一)(.+)/i, kind: 'decision' },
  { re: /(?:we decided|decision is)[:：,,\s]*(.+)/i, kind: 'decision' },
]

/** Secret 模式:命中则 AUTO_EXTRACTION = DENY,且 model-facing remember 拒绝。 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /(?:password|passwd|pwd|密码)\s*[:=是为]\s*\S+/i,
  /(?:api[\s_-]?key|apikey|secret[\s_-]?key|access[\s_-]?key)\s*[:=是为]\s*\S+/i,
  /(?:token|bearer|authorization)\s*[:=是为]\s*\S+/i,
  /(?:private[\s_-]?key|ssh[\s_-]?key|私钥)\s*[:=是为]\s*\S+/i,
  /\b(?:sk|pk|ghp|xoxb|AKIA)[A-Za-z0-9_-]{16,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b\d{16}\b.*\b(?:cvv|cvc)\b/i,
]

/** 敏感个人资料模式:命中则 AUTO_EXTRACTION = DENY。 */
const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /(?:诊断|确诊|病史|病例|mental health|diagnos)/i,
  /(?:政治立场|政党|political affiliation|vote for)/i,
  /(?:宗教信仰|religion|religious belief)/i,
  /(?:性取向|sexual orientation|gender identity)/i,
  /(?:银行卡|信用卡|card number|bank account|iban|swift)/i,
]

export interface ExtractedMemory {
  content: string
  kind: MemoryKind
}

export function isSecretLike(content: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(content))
}

export function isSensitiveContent(content: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(content))
}

/** 内容是否允许自动提取/记忆(非 secret、非敏感)。 */
export function isMemoryAllowed(content: string): boolean {
  return !isSecretLike(content) && !isSensitiveContent(content)
}

/** 基于内容推断 kind(当无显式模式时)。 */
export function inferKind(content: string): MemoryKind {
  if (/偏好|喜欢|习惯|prefer|like|favorite/i.test(content)) return 'preference'
  if (/以后|一律|统一|始终|always|from now on|must|禁止|不要/i.test(content)) return 'instruction'
  if (/决定|确定|采用|选择|decision|decided/i.test(content)) return 'decision'
  if (/是|为|=|is|are|代号|名称|名字/i.test(content)) return 'fact'
  return 'other'
}

function firstSentence(text: string): string {
  const line = text.split(/\r?\n/)[0] ?? ''
  const cut = line.split(/(?<=[。.!?;；])\s*/)[0] ?? line
  return cut.trim().replace(/^[,，:：\s]+/, '').replace(/[,，。;；\s]+$/, '')
}

/**
 * 从用户消息中提取显式记忆(确定性)。
 * 只返回通过 secret/敏感过滤的条目。同一消息最多提取 3 条。
 */
export function extractExplicitMemories(text: string, maxItems = 3): ExtractedMemory[] {
  const out: ExtractedMemory[] = []
  const seen = new Set<string>()
  for (const { re, kind } of EXPLICIT_PATTERNS) {
    const match = re.exec(text)
    if (match === null || match[1] === undefined) continue
    const content = firstSentence(match[1])
    if (content.length < 2 || content.length > 500) continue
    if (!isMemoryAllowed(content)) continue
    const key = content.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ content, kind })
    if (out.length >= maxItems) break
  }
  return out
}
