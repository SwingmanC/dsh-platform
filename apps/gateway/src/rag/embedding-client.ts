/**
 * K-T3:Embedding Provider 客户端(供应商无关,第一阶段仅 openai-compatible)。
 *
 * 契约:POST {base_url}/embeddings,Body { model, input: string[] },响应 data[].embedding。
 * - 出站前经 egress SSRF 校验(沿用平台 MCP outbound policy);
 * - 批次 ≤ 20,超出由 client 分批(顺序串行,无并发调度);
 * - 硬超时(AbortController,默认 10s),超时 abort 并返回结构化错误,不重试;
 * - 响应校验:data[] 数量与输入一致;每条 embedding 非空数组且全为有限 number;
 * - 维度校验:dims > 0 时 vector.length 必须等于 dims(dimension-mismatch)。
 *
 * 错误码(受控,无 stack/secret):
 *   embedding-config-invalid:<reason> | embedding-timeout | provider-error:<status>
 *   embedding-response-invalid | dimension-mismatch
 */
import { validateEgressUrl, type EgressPolicy } from '../egress.js'

export const EMBEDDING_BATCH_MAX = 20
export const EMBEDDING_TIMEOUT_MS = 10_000

export interface EmbeddingProviderConfig {
  baseUrl: string
  model: string
  dims: number
  apiKey: string | null
}

export interface EmbeddingCallOptions {
  timeoutMs?: number
  batchSize?: number
  /** 出站策略(沿用平台 MCP outbound policy 值)。 */
  egressPolicy?: EgressPolicy
}

/** 结构化 embedding 错误(code 受控)。 */
export class EmbeddingProviderError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'EmbeddingProviderError'
  }
}

/** 校验 base_url(出站前;SSRF/元数据/策略)。未提供 policy 时默认全拒(由调用方显式传入平台策略)。 */
export function resolveEmbeddingEndpoint(baseUrl: string, policy?: EgressPolicy): string {
  const v = validateEgressUrl(baseUrl, policy ?? { allowedOrigins: [], allowLoopback: false })
  if (!v.ok) throw new EmbeddingProviderError(`embedding-config-invalid:${v.reason}`)
  return v.url.endsWith('/') ? v.url : `${v.url}/`
}

function assertFiniteVector(v: unknown, dims: number): number[] {
  if (!Array.isArray(v) || v.length === 0) throw new EmbeddingProviderError('embedding-response-invalid')
  const out: number[] = []
  for (const n of v) {
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new EmbeddingProviderError('embedding-response-invalid')
    out.push(n)
  }
  if (dims > 0 && out.length !== dims) throw new EmbeddingProviderError('dimension-mismatch')
  return out
}

async function embedBatch(
  endpoint: string,
  config: EmbeddingProviderConfig,
  texts: string[],
  timeoutMs: number,
): Promise<number[][]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (config.apiKey !== null && config.apiKey !== '') headers.authorization = `Bearer ${config.apiKey}`
    const res = await fetch(`${endpoint}embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.model, input: texts }),
      signal: controller.signal,
    })
    if (!res.ok) {
      // 不读取详细 body(可能回显敏感信息),仅状态码结构化。
      throw new EmbeddingProviderError(`provider-error:${res.status}`)
    }
    const json = (await res.json()) as { data?: Array<{ embedding?: unknown }> }
    const data = json?.data
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new EmbeddingProviderError('embedding-response-invalid')
    }
    return data.map((d) => assertFiniteVector(d?.embedding, config.dims))
  } catch (err) {
    if (err instanceof EmbeddingProviderError) throw err
    // AbortError → 超时;其余网络错误 → provider-error(消息不含 header/secret)。
    const aborted = controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')
    throw new EmbeddingProviderError(aborted ? 'embedding-timeout' : 'provider-error:network')
  } finally {
    clearTimeout(timer)
  }
}

/** 批量向量化:分批(≤ batchSize,默认 20)顺序调用,返回与输入顺序一致的向量数组。 */
export async function embedTexts(
  config: EmbeddingProviderConfig,
  texts: string[],
  opts: EmbeddingCallOptions = {},
): Promise<number[][]> {
  const endpoint = resolveEmbeddingEndpoint(config.baseUrl, opts.egressPolicy)
  const batchSize = Math.min(Math.max(1, opts.batchSize ?? EMBEDDING_BATCH_MAX), EMBEDDING_BATCH_MAX)
  const timeoutMs = opts.timeoutMs ?? EMBEDDING_TIMEOUT_MS
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize)
    out.push(...(await embedBatch(endpoint, config, batch, timeoutMs)))
  }
  return out
}
