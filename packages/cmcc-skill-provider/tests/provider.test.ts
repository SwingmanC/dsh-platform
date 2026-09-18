/**
 * cmcc-skill-provider 测试:投影读取 / list/get / 校验降级 / watcher 失效。
 * 无 DSH Runtime、无网络、无 DB。
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ProjectionSkillProvider, readBody, readCatalog } from '../src/projection-reader.ts'
import { validateCatalog } from '../src/validation.ts'
import { watchCatalog } from '../src/watcher.ts'
import { CMCC_PLATFORM_SKILL_RANK } from '../src/contract.ts'
import type { SkillProviderControl } from '../src/contract.ts'

const SKILL_ID = '11111111-1111-1111-1111-111111111111'
const BODY = '# Net Ops\nUNIQUE_BODY_MARKER_04'

async function makeProjection(opts: { name?: string; body?: string | null; omitBody?: boolean; badSchema?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cmcc-proj-'))
  await mkdir(path.join(dir, 'bodies'), { recursive: true })
  const name = opts.name ?? 'net-ops'
  const catalog = {
    schemaVersion: opts.badSchema === true ? 99 : 1,
    revision: 'rev-abc',
    generatedAt: new Date().toISOString(),
    skills: [{
      id: SKILL_ID, name, description: 'net operations', invocation: { modelInvocable: true, userInvocable: true },
      version: '1.0.0', bodyFile: `bodies/${SKILL_ID}.md`,
    }],
  }
  await writeFile(path.join(dir, 'catalog.json'), JSON.stringify(catalog), 'utf8')
  if (opts.omitBody !== true) {
    await writeFile(path.join(dir, 'bodies', `${SKILL_ID}.md`), opts.body === null ? '' : (opts.body ?? BODY), 'utf8')
  }
  return dir
}

function fakeControl(): { control: SkillProviderControl; invalidations: () => number } {
  let count = 0
  const ac = new AbortController()
  return { control: { signal: ac.signal, invalidate: () => { count += 1 } }, invalidations: () => count }
}

test('validateCatalog: valid ok, bad schema/name rejected', () => {
  const good = { schemaVersion: 1, revision: 'r', generatedAt: '', skills: [{ id: SKILL_ID, name: 'net-ops', description: 'd', invocation: { modelInvocable: true, userInvocable: true }, version: '1', bodyFile: `bodies/${SKILL_ID}.md` }] }
  assert.ok(validateCatalog(good))
  assert.equal(validateCatalog({ ...good, schemaVersion: 2 }), null)
  const badName = { ...good, skills: [{ ...good.skills[0], name: 'Net Ops' }] }
  assert.equal(validateCatalog(badName), null)
  const badBody = { ...good, skills: [{ ...good.skills[0], bodyFile: '../etc/passwd' }] }
  assert.equal(validateCatalog(badBody), null)
})

test('list: returns candidates with rank 350 + kebab name + locator', async () => {
  const dir = await makeProjection()
  const { control } = fakeControl()
  const provider = new ProjectionSkillProvider(dir, control)
  const candidates = await provider.list({})
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].name, 'net-ops')
  assert.equal(candidates[0].rank, CMCC_PLATFORM_SKILL_RANK)
  assert.equal(candidates[0].provider, 'cmcc-platform')
  assert.deepEqual(candidates[0].invocation, { modelInvocable: true, userInvocable: true })
  // ack 写入 observedRevision
  const ack = JSON.parse(await readFile(path.join(dir, 'ack.json'), 'utf8'))
  assert.equal(ack.observedRevision, 'rev-abc')
  assert.equal(ack.error, null)
})

test('get: returns real body by marker', async () => {
  const dir = await makeProjection()
  const { control } = fakeControl()
  const provider = new ProjectionSkillProvider(dir, control)
  const candidates = await provider.list({})
  const def = await provider.get(candidates[0], {})
  assert.ok(def)
  assert.match(def.content, /UNIQUE_BODY_MARKER_04/)
  assert.equal(def.provider, 'cmcc-platform')
  assert.equal(def.resourceBase.kind, 'opaque')
})

test('get: missing body returns undefined (safe failure)', async () => {
  const dir = await makeProjection({ omitBody: true })
  const { control } = fakeControl()
  const provider = new ProjectionSkillProvider(dir, control)
  const candidates = await provider.list({})
  assert.equal(await provider.get(candidates[0], {}), undefined)
})

test('corrupt catalog: list degrades to empty + ack error (no crash)', async () => {
  const dir = await makeProjection({ badSchema: true })
  const { control } = fakeControl()
  const provider = new ProjectionSkillProvider(dir, control)
  const candidates = await provider.list({})
  assert.deepEqual(candidates, [])
  const ack = JSON.parse(await readFile(path.join(dir, 'ack.json'), 'utf8'))
  assert.equal(ack.error, 'catalog-unavailable')
})

test('readBody: rejects non-uuid locator (path traversal defense)', async () => {
  const dir = await makeProjection()
  assert.equal(await readBody(dir, '../catalog'), null)
})

test('watcher: catalog change triggers debounced invalidate; close stops it', async () => {
  const dir = await makeProjection()
  const { control, invalidations } = fakeControl()
  const w = watchCatalog(dir, control.signal, () => control.invalidate(), 30)
  await writeFile(path.join(dir, 'catalog.json'), JSON.stringify({ schemaVersion: 1, revision: 'rev-2', generatedAt: '', skills: [] }), 'utf8')
  await new Promise((r) => setTimeout(r, 300))
  assert.ok(invalidations() >= 1, 'expected invalidate after catalog change')
  w.close()
  const before = invalidations()
  await writeFile(path.join(dir, 'catalog.json'), JSON.stringify({ schemaVersion: 1, revision: 'rev-3', generatedAt: '', skills: [] }), 'utf8')
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(invalidations(), before, 'closed watcher must not fire')
})
