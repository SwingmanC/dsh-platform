/**
 * Knowledge 面板 —— 知识中心。
 *
 * Phase 05:文档上传/Ingestion/Runtime 投影就绪。
 */
import * as React from 'react'
import { platformApi } from '../platform-api.js'
import type { KbChunk, KbDocument, KnowledgeBase } from '../models/types.js'
import {
  createKnowledgeBaseAndReload, docStatusLabel, kbVisibilityLabel,
  knowledgeRuntimeStateLabel, loadDocuments, loadKnowledge,
  mountKnowledgeBaseAndReload, searchChunks, unmountKnowledgeBaseAndReload,
} from '../models/knowledge.js'
import type { KnowledgePanelData } from '../models/knowledge.js'
import { useAsyncState, useMutation } from '../components/hooks.js'
import {
  Card, Chip, PanelContent, PanelEmpty, PanelError, PanelHeader, PanelLoading,
  PanelToolbar, PlatformPanel, Select, TextInput, buttonStyle,
} from '../components/PanelShell.js'

export function KnowledgePanel(): React.ReactElement {
  const [name, setName] = React.useState('')
  const [visibility, setVisibility] = React.useState('personal')
  const [showCreate, setShowCreate] = React.useState(false)
  const [selectedKb, setSelectedKb] = React.useState<string | null>(null)
  const [search, setSearch] = React.useState('')
  const [uploadingKb, setUploadingKb] = React.useState<string | null>(null)

  const { state, reload, setState } = useAsyncState<KnowledgePanelData>(() => loadKnowledge(platformApi), [])
  const docs = useAsyncState<KbDocument[]>(
    () => (selectedKb === null ? Promise.resolve({ status: 'empty', data: [] }) : loadDocuments(platformApi, selectedKb)),
    [selectedKb],
  )
  const searchState = useAsyncState<KbChunk[]>(
    () => (search.trim() === ''
      ? Promise.resolve({ status: 'empty', data: [] })
      : searchChunks(platformApi, { q: search.trim() }).then((r) => (r.status === 'ready' ? { status: 'ready', data: r.data.chunks } : r.status === 'empty' ? { status: 'empty', data: [] } : r))),
    [search],
  )
  const mutation = useMutation()

  const afterMutation = (next: Awaited<ReturnType<typeof loadKnowledge>>): void => { setState(next) }

  // --- K-T3:Embedding Provider 配置(仅 tenant_admin;非管理员 403 时自动隐藏) ---
  const [showEmbedding, setShowEmbedding] = React.useState(false)
  const [emb, setEmb] = React.useState<{
    loaded: boolean; visible: boolean; provider: string; baseUrl: string; model: string
    dims: string; apiKey: string; hasKey: boolean; keyHint: string | null
    status: string | null; error: string | null
  }>({ loaded: false, visible: false, provider: 'openai-compatible', baseUrl: '', model: '', dims: '', apiKey: '', hasKey: false, keyHint: null, status: null, error: null })
  const loadEmbedding = (): void => {
    platformApi.getEmbeddingConfig()
      .then((v) => setEmb((s) => ({
        ...s, loaded: true, visible: true, provider: v.provider, baseUrl: v.baseUrl, model: v.model,
        dims: String(v.dims), hasKey: v.hasKey, keyHint: v.keyHint, apiKey: '',
      })))
      .catch(() => setEmb((s) => ({ ...s, loaded: true, visible: false })))
  }
  const openEmbedding = (): void => {
    setShowEmbedding((v) => !v)
    if (!emb.loaded) loadEmbedding()
  }
  const saveEmbedding = async (): Promise<void> => {
    setEmb((s) => ({ ...s, status: null, error: null }))
    const view = await platformApi.saveEmbeddingConfig({
      provider: emb.provider, baseUrl: emb.baseUrl.trim(), model: emb.model.trim(),
      dims: Number(emb.dims), apiKey: emb.apiKey.trim(),
    })
    setEmb((s) => ({ ...s, loaded: true, provider: view.provider, baseUrl: view.baseUrl, model: view.model, dims: String(view.dims), hasKey: view.hasKey, keyHint: view.keyHint, apiKey: '', status: 'saved' }))
  }
  const testEmbedding = async (): Promise<void> => {
    setEmb((s) => ({ ...s, status: null, error: null }))
    const r = await platformApi.testEmbeddingConfig()
    if (r.ok) setEmb((s) => ({ ...s, status: `连接成功 · dims=${r.dims} · ${r.latencyMs}ms` }))
    else setEmb((s) => ({ ...s, status: `测试失败:${r.code ?? 'unknown'}` }))
  }

  const handleUpload = async (kbId: string): Promise<void> => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.txt,.md,.pdf,.docx,text/plain,text/markdown,application/pdf'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      setUploadingKb(kbId)
      try {
        const lower = file.name.toLowerCase()
        if (lower.endsWith('.pdf') || lower.endsWith('.docx')) {
          // K-T1:二进制文档走 multipart 通道(txt/md 保持既有 JSON 上传)。
          await platformApi.uploadDocumentFile(kbId, file)
        } else {
          const content = await file.text()
          await platformApi.uploadDocument(kbId, file.name, content)
        }
        await reload()
        if (selectedKb === kbId) docs.reload()
      } catch (err) {
        mutation.run(async () => { throw err }, () => {})
      } finally {
        setUploadingKb(null)
      }
    }
    input.click()
  }

  return (
    <PlatformPanel>
      <PanelHeader
        title="知识中心"
        subtitle="平台知识库 · 文档上传/Ingestion/Runtime 投影已就绪"
        capability="knowledge"
      />
      {state.status === 'ready' && (
        <PanelContent>
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #5b6473)', marginBottom: 8 }}>
            {state.data.runtime === null
              ? 'Runtime 投影:状态不可用'
              : `Runtime 投影:${knowledgeRuntimeStateLabel(state.data.runtime.state)}`
                + (state.data.runtime.state === 'CONNECTED'
                  ? ` · observed=${state.data.runtime.observedRevision ?? '?'}`
                  : state.data.runtime.desiredRevision !== null
                    ? ` · desired=${state.data.runtime.desiredRevision} observed=${state.data.runtime.observedRevision ?? '—'}`
                    : '')
                + (state.data.runtime.error !== null ? ` · ${state.data.runtime.error}` : '')
                + ` · chunks=${state.data.runtime.chunkCount}`}
          </div>
        </PanelContent>
      )}
      <PanelToolbar>
        <button type="button" style={buttonStyle()} onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? '取消' : '新建知识库'}
        </button>
        <button type="button" style={buttonStyle('ghost')} onClick={openEmbedding}>
          {showEmbedding ? '收起 Embedding 配置' : 'Embedding 配置'}
        </button>
        {mutation.pending && <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #5b6473)' }}>处理中…</span>}
      </PanelToolbar>

      {showEmbedding && emb.visible && (
        <PanelContent>
          <Card>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 640, fontSize: 13 }}>
              <div style={{ fontWeight: 600 }}>Embedding Provider(租户级 · 仅管理员)</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <TextInput value={emb.provider} readOnly />
                <TextInput placeholder="Base URL(https://...)" value={emb.baseUrl} onChange={(e) => setEmb((s) => ({ ...s, baseUrl: e.target.value }))} />
                <TextInput placeholder="Model" value={emb.model} onChange={(e) => setEmb((s) => ({ ...s, model: e.target.value }))} />
                <TextInput placeholder="Dimensions(如 1024)" value={emb.dims} onChange={(e) => setEmb((s) => ({ ...s, dims: e.target.value }))} />
                <TextInput
                  type="password"
                  placeholder={emb.hasKey ? `••••${emb.keyHint ?? ''}(已保存)` : 'API Key'}
                  value={emb.apiKey}
                  onChange={(e) => setEmb((s) => ({ ...s, apiKey: e.target.value }))}
                />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" style={buttonStyle()} disabled={mutation.pending} onClick={() => mutation.run(saveEmbedding, () => setEmb((s) => ({ ...s, status: 'saved' })))}>
                  保存
                </button>
                <button type="button" style={buttonStyle('ghost')} disabled={mutation.pending || emb.baseUrl.trim() === ''} onClick={() => mutation.run(testEmbedding, () => {})}>
                  测试连接
                </button>
              </div>
              {emb.status !== null && <div style={{ fontSize: 12, color: emb.status.startsWith('测试失败') ? 'var(--dsw-alias-status-danger, #c0392b)' : 'var(--dsw-alias-status-success, #1e7e34)' }}>{emb.status}</div>}
              <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #5b6473)' }}>
                保存后仍使用关键词检索;Embedding 能力不影响现有 LIKE Search。
              </div>
            </div>
          </Card>
        </PanelContent>
      )}

      <PanelContent>
        <div style={{ marginBottom: 8, fontSize: 13 }}>知识库</div>
        {state.status === 'loading' && <PanelLoading />}
        {state.status === 'error' && <PanelError message={state.message} onRetry={reload} />}
        {state.status === 'empty' && <PanelEmpty text="暂无知识库" hint="点击「新建知识库」创建第一个" />}
        {state.status === 'ready' && (
          <>
            {showCreate && (
              <Card>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <TextInput placeholder="知识库名称(必填)" value={name} onChange={(e) => setName(e.target.value)} />
                  <Select value={visibility} onChange={(e) => setVisibility(e.target.value)}>
                    <option value="personal">个人</option>
                    <option value="tenant">租户</option>
                  </Select>
                  <button
                    type="button"
                    style={buttonStyle()}
                    disabled={mutation.pending || name.trim() === ''}
                    onClick={() => mutation.run(
                      () => createKnowledgeBaseAndReload(platformApi, { name: name.trim(), visibility }),
                      (next) => { afterMutation(next); if (next.status !== 'error') { setName(''); setShowCreate(false) } },
                    )}
                  >
                    创建
                  </button>
                </div>
              </Card>
            )}
            {state.data.bases.map((kb) => (
              <KnowledgeCard
                key={kb.id}
                kb={kb}
                mounted={state.data.mountedIds.includes(kb.id)}
                selected={selectedKb === kb.id}
                pending={mutation.pending}
                uploading={uploadingKb === kb.id}
                onSelect={() => setSelectedKb(selectedKb === kb.id ? null : kb.id)}
                onMount={() => mutation.run(() => mountKnowledgeBaseAndReload(platformApi, kb.id), afterMutation)}
                onUnmount={() => mutation.run(() => unmountKnowledgeBaseAndReload(platformApi, kb.id), afterMutation)}
                onUpload={() => handleUpload(kb.id)}
              />
            ))}
          </>
        )}
      </PanelContent>

      {selectedKb !== null && (
        <PanelContent>
          <div style={{ margin: '4px 0 8px', fontSize: 13 }}>文档</div>
          {docs.state.status === 'loading' && <PanelLoading label="加载文档…" />}
          {docs.state.status === 'error' && <PanelError message={docs.state.message} onRetry={docs.reload} />}
          {docs.state.status === 'empty' && <PanelEmpty text="暂无可检索文档" hint="点击「上传文档」上传并自动 Ingestion" />}
          {docs.state.status === 'ready' && docs.state.data.map((doc) => (
            <Card key={doc.id}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 13 }}>{doc.filename}</strong>
                <Chip>{docStatusLabel(doc.status)}</Chip>
                <Chip>{Math.max(1, Math.round(doc.fileSize / 1024))} KB</Chip>
                <Chip>v{doc.currentVersion}</Chip>
              </div>
            </Card>
          ))}
        </PanelContent>
      )}

      <PanelContent>
        <div style={{ margin: '4px 0 8px', fontSize: 13 }}>平台检索</div>
        <PanelToolbar>
          <TextInput
            placeholder="输入关键词检索 chunks"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') searchState.reload() }}
          />
          <button type="button" style={buttonStyle('ghost')} onClick={searchState.reload}>检索</button>
        </PanelToolbar>
        {search.trim() === '' && <PanelEmpty text="输入关键词开始检索" hint="检索基于已 mount KB 的 ready chunks" />}
        {search.trim() !== '' && searchState.state.status === 'loading' && <PanelLoading label="检索中…" />}
        {search.trim() !== '' && searchState.state.status === 'error' && <PanelError message={searchState.state.message} onRetry={searchState.reload} />}
        {search.trim() !== '' && searchState.state.status === 'empty' && <PanelEmpty text="暂无匹配结果" />}
        {search.trim() !== '' && searchState.state.status === 'ready' && searchState.state.data.map((chunk) => (
          <Card key={chunk.id}>
            <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{chunk.content}</div>
            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--dsw-alias-label-secondary, #5b6473)' }}>
              {chunk.citation !== undefined
                ? `来源:${chunk.citation.documentTitle} · 知识库:${chunk.citation.kbId}`
                : `kb=${chunk.kbId} · chunk#${chunk.chunkIndex}`}
            </div>
          </Card>
        ))}
      </PanelContent>
    </PlatformPanel>
  )
}

function KnowledgeCard(props: {
  kb: KnowledgeBase
  mounted: boolean
  selected: boolean
  pending: boolean
  uploading: boolean
  onSelect: () => void
  onMount: () => void
  onUnmount: () => void
  onUpload: () => void
}): React.ReactElement {
  const { kb } = props
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 14 }}>{kb.name}</strong>
            <Chip>{kbVisibilityLabel(kb.visibility)}</Chip>
            <Chip>{kb.docCount} 文档</Chip>
            {props.mounted && <Chip>已挂载</Chip>}
          </div>
          {kb.description !== null && kb.description !== '' && (
            <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--dsw-alias-label-secondary, #5b6473)' }}>{kb.description}</p>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button type="button" style={buttonStyle('ghost')} disabled={props.uploading} onClick={props.onUpload}>
            {props.uploading ? '上传中…' : '上传文档'}
          </button>
          <button type="button" style={buttonStyle('ghost')} onClick={props.onSelect}>
            {props.selected ? '收起' : '文档'}
          </button>
          {props.mounted
            ? <button type="button" style={buttonStyle('ghost')} disabled={props.pending} onClick={props.onUnmount}>取消挂载</button>
            : <button type="button" style={buttonStyle()} disabled={props.pending} onClick={props.onMount}>挂载</button>}
        </div>
      </div>
    </Card>
  )
}