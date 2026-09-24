import assert from 'node:assert/strict'
import test from 'node:test'
import { UsageCollector, usageFromEvent } from '../src/index.js'

test('extracts authoritative assistant usage', () => {
  const result = usageFromEvent({ id: 'session-1' }, { type: 'assistant/message', seq: 7, time: 1_700_000_000_000,
    data: { provider: 'deepseek', model: 'deepseek-chat', usage: {
      inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 4, reasoningTokens: 2,
    } } })
  assert.deepEqual(result, { sessionId: 'session-1', eventSeq: 7, occurredAt: '2023-11-14T22:13:20.000Z',
    provider: 'deepseek', model: 'deepseek-chat', eventType: 'message', turn: null, step: null, usageKnown: true,
    inputTokens: 100, outputTokens: 20,
    cacheReadTokens: 30, cacheWriteTokens: 4, reasoningTokens: 2 })
})

test('reads provider and model from DSH assistant message source', () => {
  const result = usageFromEvent({ id: 'session-2' }, { type: 'assistant/message', seq: 16,
    data: { message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
      usage: { inputTokens: 8853, outputTokens: 167, reasoningTokens: 20 } } })
  assert.equal(result?.provider, 'deepseek-official')
  assert.equal(result?.model, 'deepseek-flash')
  assert.equal(result?.inputTokens, 8853)
  assert.equal(result?.outputTokens, 167)
})

test('model source takes precedence over legacy top-level fields', () => {
  const result = usageFromEvent({ id: 'session-3' }, { type: 'assistant/message', seq: 1,
    data: { provider: 'stale', model: 'stale', message: { source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
      usage: { inputTokens: 1 } } })
  assert.equal(result?.provider, 'deepseek-official')
  assert.equal(result?.model, 'deepseek-flash')
})

test('counts a failed/retried attempt from its final stream usage and remembered route', () => {
  const collector = new UsageCollector()
  const session = { id: 'retry-session' }
  collector.collect(session, { type: 'request/context', seq: 1, data: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  const failed = collector.collect(session, { type: 'assistant/attempt', seq: 7, data: { turn: 2, step: 1, stream: [
    { type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens: 80, outputTokens: 5 } } },
    { type: 'chunk', time: 2, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 10 } } },
  ] } })
  const success = collector.collect(session, { type: 'assistant/message', seq: 10, data: { turn: 2, step: 1,
    message: { source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
    usage: { inputTokens: 120, outputTokens: 20 } } })
  assert.equal(failed?.eventType, 'attempt')
  assert.equal(failed?.inputTokens, 100)
  assert.equal(failed?.outputTokens, 10)
  assert.equal(failed?.provider, 'deepseek-official')
  assert.equal(failed?.turn, 2)
  assert.equal(success?.eventType, 'message')
  assert.equal(success?.inputTokens, 120)
  assert.notEqual(failed?.eventSeq, success?.eventSeq)
})

test('failed attempt without authoritative usage counts only the attempt', () => {
  const result = usageFromEvent({ id: 's' }, { type: 'assistant/attempt', seq: 3,
    data: { turn: 1, step: 1, stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error' } } }] } })
  assert.equal(result?.usageKnown, false)
  assert.equal(result?.inputTokens, 0)
  assert.equal(result?.eventType, 'attempt')
})

test('ignores structural events and marks malformed usage as unknown', () => {
  assert.equal(usageFromEvent({ id: 's' }, { type: 'turn/end', seq: 1, data: {} }), null)
  assert.equal(usageFromEvent({ id: 's' }, { type: 'assistant/message', seq: 2, data: { usage: {} } })?.usageKnown, false)
  assert.equal(usageFromEvent({ id: 's' }, { type: 'assistant/message', seq: 3, data: { usage: { inputTokens: 0, outputTokens: 0 } } })?.usageKnown, true)
})

test('interrupted message retains authoritative usage when present', () => {
  const result = usageFromEvent({ id: 's' }, { type: 'assistant/message', seq: 4,
    data: { turn: 1, step: 1, interrupted: true, usage: { inputTokens: 55, outputTokens: 2 } } })
  assert.equal(result?.usageKnown, true)
  assert.equal(result?.inputTokens, 55)
})
