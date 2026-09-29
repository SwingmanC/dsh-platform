/**
 * 出站 URL 校验(K-T3 从 mcp-projection 抽取的最小公共 helper)。
 *
 * 策略与 MCP outbound 一致:
 * - 仅 http/https;禁 userinfo/fragment;
 * - 云元数据地址硬拒绝(即使被显式 allowlist);
 * - origin allowlist + loopback 开关(生产默认 deny)。
 */

export interface EgressPolicy {
  allowedOrigins: readonly string[]
  allowLoopback: boolean
}

/** 校验出站 URL 是否符合 SSRF / egress policy。 */
export function validateEgressUrl(
  rawUrl: string,
  policy: EgressPolicy,
): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'invalid-url' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, reason: 'invalid-scheme' }
  if (parsed.username !== '' || parsed.password !== '') return { ok: false, reason: 'userinfo-not-allowed' }
  if (parsed.hash !== '') return { ok: false, reason: 'fragment-not-allowed' }
  // 云元数据地址硬拒绝:即使被显式 allowlist 也不放行(防 SSRF 配置失误)。
  const host = parsed.hostname.toLowerCase()
  if (host === '169.254.169.254' || host === 'metadata.google.internal') {
    return { ok: false, reason: 'metadata-host-forbidden' }
  }
  const origin = parsed.origin
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1'
  if (policy.allowedOrigins.includes(origin)) return { ok: true, url: parsed.toString() }
  if (loopback && policy.allowLoopback) return { ok: true, url: parsed.toString() }
  return { ok: false, reason: 'origin-not-allowed' }
}
