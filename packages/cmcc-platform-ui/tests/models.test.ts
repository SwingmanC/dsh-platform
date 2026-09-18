/**
 * Panel model 测试:loading / ready / empty / error + mutation 真实调用后重新读取。
 * 使用 mock API(无网络、无浏览器)。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadSkills, createSkillAndReload, installSkillAndReload, uninstallSkillAndReload } from '../src/client/models/skills.ts'
import type { SkillApi } from '../src/client/models/skills.ts'
import { loadKnowledge, searchChunks } from '../src/client/models/knowledge.ts'
import type { KnowledgeApi } from '../src/client/models/knowledge.ts'
import { loadMcp, authorizeConnectorAndReload } from '../src/client/models/mcp.ts'
import type { McpApi } from '../src/client/models/mcp.ts'
import { loadMemory, deleteMemoryAndReload } from '../src/client/models/memory.ts'
import type { MemoryApi } from '../src/client/models/memory.ts'
import type { Skill, KnowledgeBase, MCPConnector, MemoryRecord } from '../src/client/models/types.ts'

const skill = (id: string): Skill => ({
  id, tenantId: 't1', creatorId: 'u1', name: id, slug: id, description: null, prompt: null,
  visibility: 'private', status: 'published', latestVersion: '1.0.0', category: null,
  usageCount: 0, installCount: 0, createdAt: '', updatedAt: '',
})

test('loadSkills: ready / empty / error', async () => {
  const ready = await loadSkills({
    listSkills: async () => ({ skills: [skill('a')], total: 1 }),
    listInstalledSkills: async () => ({ skills: [] }),
    createSkill: async () => skill('x'), publishSkill: async () => ({ ok: true }),
    installSkill: async () => ({ ok: true }), uninstallSkill: async () => ({ ok: true }),
  } as SkillApi)
  assert.equal(ready.status, 'ready')

  const empty = await loadSkills({
    listSkills: async () => ({ skills: [], total: 0 }),
    listInstalledSkills: async () => ({ skills: [] }),
    createSkill: async () => skill('x'), publishSkill: async () => ({ ok: true }),
    installSkill: async () => ({ ok: true }), uninstallSkill: async () => ({ ok: true }),
  } as SkillApi)
  assert.equal(empty.status, 'empty')

  const error = await loadSkills({
    listSkills: async () => { throw new Error('boom') },
    listInstalledSkills: async () => ({ skills: [] }),
    createSkill: async () => skill('x'), publishSkill: async () => ({ ok: true }),
    installSkill: async () => ({ ok: true }), uninstallSkill: async () => ({ ok: true }),
  } as SkillApi)
  assert.equal(error.status, 'error')
})

test('skill mutation: install then reload reflects server state', async () => {
  const calls: string[] = []
  let installed = false
  const api = {
    listSkills: async () => { calls.push('list'); return { skills: [skill('a')], total: 1 } },
    listInstalledSkills: async () => { calls.push('installed'); return { skills: installed ? [skill('a')] : [] } },
    createSkill: async () => skill('x'), publishSkill: async () => ({ ok: true }),
    installSkill: async (id: string) => { calls.push('install:' + id); installed = true; return { ok: true } as const },
    uninstallSkill: async () => ({ ok: true } as const),
  } as SkillApi
  const result = await installSkillAndReload(api, 'a')
  assert.deepEqual(calls, ['install:a', 'list', 'installed'])
  assert.equal(result.status, 'ready')
  if (result.status === 'ready') assert.deepEqual(result.data.installedIds, ['a'])
})

test('skill mutation: create failure surfaces as rejected promise (visible)', async () => {
  const api = {
    listSkills: async () => ({ skills: [], total: 0 }),
    listInstalledSkills: async () => ({ skills: [] }),
    createSkill: async () => { throw new Error('name-required') },
    publishSkill: async () => ({ ok: true }), installSkill: async () => ({ ok: true }), uninstallSkill: async () => ({ ok: true }),
  } as SkillApi
  await assert.rejects(() => createSkillAndReload(api, { name: '' }))
})

test('loadKnowledge: ready + mountedIds', async () => {
  const kb = (id: string): KnowledgeBase => ({
    id, tenantId: 't1', creatorId: 'u1', name: id, description: null, visibility: 'personal',
    category: null, docCount: 0, status: 'active', createdAt: '', updatedAt: '',
  })
  const api = {
    listKnowledgeBases: async () => ({ knowledgeBases: [kb('k1')] }),
    listMounts: async () => ({ mounts: [kb('k1')] }),
    createKnowledgeBase: async () => kb('k2'),
    mountKnowledgeBase: async () => ({ ok: true } as const),
    listKbDocuments: async () => ({ documents: [] }),
    searchKnowledge: async () => ({ chunks: [], total: 0 }),
  } as KnowledgeApi
  const result = await loadKnowledge(api)
  assert.equal(result.status, 'ready')
  if (result.status === 'ready') assert.deepEqual(result.data.mountedIds, ['k1'])
})

test('searchChunks: empty query-less result is empty (no fake)', async () => {
  const api = { searchKnowledge: async () => ({ chunks: [], total: 0 }) } as unknown as KnowledgeApi
  const result = await searchChunks(api, { q: 'nothing' })
  assert.equal(result.status, 'empty')
})

test('loadMcp: ready + authorizedIds', async () => {
  const conn = (id: string): MCPConnector => ({
    id, tenantId: 't1', creatorId: 'u1', name: id, description: null, serverName: id,
    transport: 'streamable-http', scope: 'user', visibility: 'private', status: 'active', riskLevel: 'low',
    toolCount: 0, command: null, endpointUrl: 'http://x', authType: null, approved: true, approvedBy: null,
    lastTestAt: null, createdAt: '', updatedAt: '',
  })
  const api = {
    listConnectors: async () => ({ connectors: [conn('c1'), conn('c2')] }),
    listAuthorizedConnectors: async () => ({ connectors: [conn('c1')] }),
    createConnector: async () => conn('c3'),
    approveConnector: async () => ({ ok: true } as const),
    authorizeConnector: async () => ({ ok: true } as const),
    revokeConnector: async () => ({ ok: true } as const),
    disableConnector: async () => ({ ok: true } as const),
    saveConnectorCredential: async () => ({ ok: true, configured: true } as const),
  } as McpApi
  const result = await loadMcp(api)
  assert.equal(result.status, 'ready')
  if (result.status === 'ready') assert.deepEqual(result.data.authorizedIds, ['c1'])

  const calls: string[] = []
  const authApi = {
    ...api,
    listConnectors: async () => { calls.push('list'); return { connectors: [conn('c1')] } },
    listAuthorizedConnectors: async () => { calls.push('authorized'); return { connectors: [] } },
    authorizeConnector: async (id: string) => { calls.push('authorize:' + id); return { ok: true } as const },
  } as McpApi
  await authorizeConnectorAndReload(authApi, 'c1')
  assert.deepEqual(calls, ['authorize:c1', 'list', 'authorized'])
})

test('loadMemory: ready / empty', async () => {
  const rec = (id: string): MemoryRecord => ({
    id, tenantId: 't1', ownerUserId: 'u1', namespace: 'default', content: 'c',
    visibility: 'personal', sourceType: 'user_fact', sourceSessionId: null, sourceEventSeq: null,
    confidence: null, reviewStatus: 'approved', reviewedBy: null, createdAt: '', updatedAt: '',
  })
  const api = {
    listMemory: async () => ({ records: [rec('m1')], total: 1 }),
    listMemoryNamespaces: async () => ({ namespaces: ['default'] }),
    createMemory: async () => rec('m2'),
    deleteMemory: async () => ({ ok: true } as const),
    promoteMemory: async () => ({ ok: true } as const),
  } as MemoryApi
  assert.equal((await loadMemory(api)).status, 'ready')

  const emptyApi = {
    ...api,
    listMemory: async () => ({ records: [], total: 0 }),
  } as MemoryApi
  assert.equal((await loadMemory(emptyApi)).status, 'empty')

  const calls: string[] = []
  const delApi = {
    ...api,
    listMemory: async () => { calls.push('list'); return { records: [], total: 0 } },
    listMemoryNamespaces: async () => ({ namespaces: [] }),
    deleteMemory: async (id: string) => { calls.push('delete:' + id); return { ok: true } as const },
  } as MemoryApi
  await deleteMemoryAndReload(delApi, 'm1')
  assert.deepEqual(calls, ['delete:m1', 'list'])
})
