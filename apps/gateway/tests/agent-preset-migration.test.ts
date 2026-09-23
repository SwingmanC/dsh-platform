import { describe, it } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { migrateAgentPresetSetting, rewriteAgentPresetDefault, TARGET_AGENT_PRESETS } from '../src/agent-preset-migration.js'

describe('rewriteAgentPresetDefault (0.1.1 → 0.1.5 code → ptc)', () => {
  it('A: exact code → migrated to ptc', () => {
    const r = rewriteAgentPresetDefault('agent-presets:\n  default: code\n')
    assert.equal(r.status, 'migrated')
    assert.equal(r.from, 'code')
    assert.equal(r.to, 'ptc')
    assert.equal(r.text, 'agent-presets:\n  default: ptc\n')
  })

  it('B: default ptc → noop', () => {
    const r = rewriteAgentPresetDefault('agent-presets:\n  default: ptc\n')
    assert.equal(r.status, 'noop')
    assert.equal(r.reason, 'default-not-code')
  })

  it('C: default standard → noop', () => {
    const r = rewriteAgentPresetDefault('agent-presets:\n  default: standard\n')
    assert.equal(r.status, 'noop')
  })

  it('D: no agent-presets namespace → noop', () => {
    const r = rewriteAgentPresetDefault('ui-onboarding:\n  welcomeNoticeVersion: x\n')
    assert.equal(r.status, 'noop')
    assert.equal(r.reason, 'no-agent-presets')
  })

  it('E: custom default my-custom → noop (never rewritten)', () => {
    const r = rewriteAgentPresetDefault('agent-presets:\n  default: my-custom\n')
    assert.equal(r.status, 'noop')
    assert.equal(r.reason, 'default-not-code')
  })

  it('F: custom missing default is never rewritten to standard/ptc', () => {
    const r = rewriteAgentPresetDefault('agent-presets:\n  default: missing-custom\n')
    assert.equal(r.status, 'noop')
    assert.ok(!r.text.includes('standard'))
  })

  it('preserves unrelated settings and inline comments', () => {
    const text = 'ui-onboarding:\n  welcomeNoticeVersion: x\nagent-presets:\n  default: code # chosen\n  other: 1\nfoo: bar\n'
    const r = rewriteAgentPresetDefault(text)
    assert.equal(r.status, 'migrated')
    assert.ok(r.text.includes('welcomeNoticeVersion: x'))
    assert.ok(r.text.includes('default: ptc # chosen'))
    assert.ok(r.text.includes('other: 1'))
    assert.ok(r.text.includes('foo: bar'))
  })

  it('handles quoted scalars', () => {
    assert.equal(rewriteAgentPresetDefault('agent-presets:\n  default: "code"\n').text, 'agent-presets:\n  default: "ptc"\n')
    assert.equal(rewriteAgentPresetDefault("agent-presets:\n  default: 'code'\n").text, "agent-presets:\n  default: 'ptc'\n")
  })

  it('is idempotent (second run is a noop)', () => {
    const once = rewriteAgentPresetDefault('agent-presets:\n  default: code\n')
    const twice = rewriteAgentPresetDefault(once.text)
    assert.equal(twice.status, 'noop')
    assert.equal(twice.text, once.text)
  })

  it('does not touch a nested default outside agent-presets', () => {
    const text = 'other:\n  default: code\nagent-presets:\n  default: ptc\n'
    assert.equal(rewriteAgentPresetDefault(text).status, 'noop')
  })

  it('roster without ptc → noop', () => {
    const r = rewriteAgentPresetDefault('agent-presets:\n  default: code\n', new Set(['code', 'standard']))
    assert.equal(r.status, 'noop')
    assert.equal(r.reason, 'roster-incompatible')
  })

  it('target roster is the fixed-tag shipped set', () => {
    assert.ok(TARGET_AGENT_PRESETS.has('ptc'))
    assert.ok(TARGET_AGENT_PRESETS.has('standard'))
    assert.ok(!TARGET_AGENT_PRESETS.has('code'))
  })
})

describe('migrateAgentPresetSetting (atomic, idempotent)', () => {
  it('migrates settings.yaml atomically and is idempotent', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agent-preset-'))
    await writeFile(path.join(dir, 'settings.yaml'), 'agent-presets:\n  default: code\n', 'utf8')
    const first = await migrateAgentPresetSetting(dir)
    assert.equal(first.status, 'migrated')
    assert.equal(await readFile(path.join(dir, 'settings.yaml'), 'utf8'), 'agent-presets:\n  default: ptc\n')
    const second = await migrateAgentPresetSetting(dir)
    assert.equal(second.status, 'noop')
  })

  it('missing settings.yaml → noop', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agent-preset-'))
    const r = await migrateAgentPresetSetting(dir)
    assert.equal(r.status, 'noop')
    assert.equal(r.reason, 'no-settings-file')
  })
})
