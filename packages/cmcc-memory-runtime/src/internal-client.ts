/**
 * Runtime → Gateway internal mutation channel 客户端。
 * 只带 ephemeral token;不接受/传递 userId/tenantId。
 */

export interface InternalChannel {
  url: string
  token: string
}

async function call(channel: InternalChannel, method: string, pathname: string, body?: unknown): Promise<Response> {
  return fetch(`${channel.url}${pathname}`, {
    method,
    headers: {
      'x-runtime-token': channel.token,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export async function internalRemember(
  channel: InternalChannel, content: string, opts?: { kind?: string; namespace?: string; sourceSessionId?: string; sourceEventSeq?: number; extractionMode?: string },
): Promise<{ id: string; kind: string; scope: string } | null> {
  try {
    const res = await call(channel, 'POST', '/internal/memory/remember', { content, ...opts })
    if (!res.ok) return null
    return (await res.json()) as { id: string; kind: string; scope: string }
  } catch {
    return null
  }
}

export async function internalForget(channel: InternalChannel, memoryId: string): Promise<boolean> {
  try {
    const res = await call(channel, 'DELETE', `/internal/memory/${encodeURIComponent(memoryId)}`)
    return res.ok
  } catch {
    return false
  }
}

export async function internalExtract(
  channel: InternalChannel, sessionId: string, turn: number, memories: Array<{ content: string; kind: string }>,
): Promise<number> {
  try {
    const res = await call(channel, 'POST', '/internal/memory/extract', { sessionId, turn, memories })
    if (!res.ok) return 0
    const data = (await res.json()) as { extracted?: number }
    return data.extracted ?? 0
  } catch {
    return 0
  }
}