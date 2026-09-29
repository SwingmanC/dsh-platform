/**
 * SKILL-V1.2 单测:SKILL.md 解析/序列化/round-trip/安全边界(纯函数)。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSkillMd, serializeSkillMd, SkillMdFormatError } from '../src/skill-format.js'

const VALID = `---
name: my-skill
description: Does useful things
whenToUse: When the user asks for useful things
---

Body instructions here.
`

test('§27-1: parse valid SKILL.md', () => {
  const s = parseSkillMd(VALID)
  assert.equal(s.name, 'my-skill')
  assert.equal(s.description, 'Does useful things')
  assert.equal(s.whenToUse, 'When the user asks for useful things')
  assert.equal(s.modelInvocable, true)
  assert.equal(s.userInvocable, true)
  assert.equal(s.prompt, 'Body instructions here.')
})

test('§27-2: serialize canonical → DSH-compatible frontmatter', () => {
  const md = serializeSkillMd({
    name: 'my-skill', description: 'Does useful things', whenToUse: 'When asked',
    modelInvocable: true, userInvocable: true, prompt: 'Body.',
  })
  assert.ok(md.startsWith('---\nname: "my-skill"\ndescription: "Does useful things"\nwhenToUse: "When asked"\n---'))
  assert.ok(md.endsWith('\n\nBody.'))
  assert.ok(!md.includes('disable-model-invocation'))
  assert.ok(!md.includes('user-invocable'))
})

test('§27-3: round-trip(全字段,含 false flags)', () => {
  const canonical = {
    name: 'round-trip', description: 'desc', whenToUse: 'when needed',
    modelInvocable: false, userInvocable: false, prompt: 'Body text\nsecond line',
  }
  const back = parseSkillMd(serializeSkillMd(canonical))
  assert.equal(back.name, canonical.name)
  assert.equal(back.description, canonical.description)
  assert.equal(back.whenToUse, canonical.whenToUse)
  assert.equal(back.modelInvocable, false)
  assert.equal(back.userInvocable, false)
  assert.equal(back.prompt, canonical.prompt)
})

test('§27-4: malformed frontmatter → 拒绝', () => {
  for (const bad of ['', 'no frontmatter at all', '---\nno closing', '---\nkey without colon\n---\nbody']) {
    assert.throws(() => parseSkillMd(bad), SkillMdFormatError)
  }
})

test('§27-5: missing name → 拒绝', () => {
  assert.throws(
    () => parseSkillMd('---\ndescription: d\n---\nbody'),
    (e: unknown) => (e as SkillMdFormatError).code === 'missing-name',
  )
})

test('§27-6: missing description → 拒绝', () => {
  assert.throws(
    () => parseSkillMd('---\nname: x\n---\nbody'),
    (e: unknown) => (e as SkillMdFormatError).code === 'missing-description',
  )
})

test('§27/§4: 默认 invocation flags = true/true;布尔形态归一', () => {
  // 无 flags 键 → 默认 true/true(DSH 兼容)
  const s1 = parseSkillMd('---\nname: a\ndescription: b\n---\nbody')
  assert.equal(s1.modelInvocable, true)
  assert.equal(s1.userInvocable, true)
  // disable-model-invocation: false → 仍 true
  const s2 = parseSkillMd('---\nname: a\ndescription: b\ndisable-model-invocation: false\n---\nbody')
  assert.equal(s2.modelInvocable, true)
  // 布尔字符串形态 yes/on/1
  const s3 = parseSkillMd('---\nname: a\ndescription: b\nuser-invocable: yes\n---\nbody')
  assert.equal(s3.userInvocable, true)
  const s4 = parseSkillMd('---\nname: a\ndescription: b\nuser-invocable: 0\n---\nbody')
  assert.equal(s4.userInvocable, false)
})

test('§27/§4: legacy camelCase 键拒绝(与 DSH 一致)', () => {
  assert.throws(
    () => parseSkillMd('---\nname: a\ndescription: b\ndisableModelInvocation: true\n---\nbody'),
    (e: unknown) => (e as SkillMdFormatError).code === 'legacy-frontmatter-key:disableModelInvocation',
  )
  assert.throws(
    () => parseSkillMd('---\nname: a\ndescription: b\nuserInvocable: false\n---\nbody'),
    (e: unknown) => (e as SkillMdFormatError).code === 'legacy-frontmatter-key:userInvocable',
  )
})

test('§10: 非 boolean 值 → 受控拒绝(不静默)', () => {
  assert.throws(
    () => parseSkillMd('---\nname: a\ndescription: b\nuser-invocable: maybe\n---\nbody'),
    (e: unknown) => (e as SkillMdFormatError).code === 'invalid-boolean:user-invocable',
  )
})

test('§27: serialize modelInvocable=false 写出 disable-model-invocation', () => {
  const md = serializeSkillMd({
    name: 'x', description: 'd', modelInvocable: false, userInvocable: true, prompt: 'p',
  })
  assert.ok(md.includes('disable-model-invocation: true'))
  assert.ok(!md.includes('user-invocable'))
})
