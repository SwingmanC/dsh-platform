import assert from 'node:assert/strict'
import test from 'node:test'
import { usageFromEvent } from '../src/index.js'

test('extracts authoritative assistant usage', () => {
  const result = usageFromEvent({ id: 'session-1' }, { type: 'assistant/message', seq: 7, time: 1_700_000_000_000,
    data: { provider: 'deepseek', model: 'deepseek-chat', usage: {
      inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 4, reasoningTokens: 2,
    } } })
  assert.deepEqual(result, { sessionId: 'session-1', eventSeq: 7, occurredAt: '2023-11-14T22:13:20.000Z',
    provider: 'deepseek', model: 'deepseek-chat', inputTokens: 100, outputTokens: 20,
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

test('ignores structural and zero-usage events', () => {
  assert.equal(usageFromEvent({ id: 's' }, { type: 'turn/end', seq: 1, data: {} }), null)
  assert.equal(usageFromEvent({ id: 's' }, { type: 'assistant/message', seq: 2, data: { usage: {} } }), null)
})
