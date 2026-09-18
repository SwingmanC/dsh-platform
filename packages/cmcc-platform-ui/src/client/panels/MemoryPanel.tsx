/**
 * Memory 面板 —— 我的记忆。
 *
 * Phase 07:真实记忆列表/搜索/创建/删除/提升 + Runtime 投影 evidence(recall)。
 */
import * as React from 'react'
import { platformApi } from '../platform-api.js'
import type { MemoryRecord } from '../models/types.js'
import {
  createMemoryAndReload, deleteMemoryAndReload, loadMemory, memoryExtractionLabel,
  memoryKindLabel, memoryRuntimeStateLabel, memoryVisibilityLabel, promoteMemoryAndReload,
} from '../models/memory.js'
import type { MemoryPanelData } from '../models/memory.js'
import { useAsyncState, useMutation } from '../components/hooks.js'
import {
  Card, Chip, PanelContent, PanelEmpty, PanelError, PanelHeader, PanelLoading,
  PanelToolbar, PlatformPanel, Select, TextInput, buttonStyle,
} from '../components/PanelShell.js'

const KINDS = ['', 'preference', 'fact', 'decision', 'instruction', 'other']

export function MemoryPanel(): React.ReactElement {
  const [query, setQuery] = React.useState('')
  const [applied, setApplied] = React.useState('')
  const [namespace, setNamespace] = React.useState('')
  const [kindFilter, setKindFilter] = React.useState('')
  const [content, setContent] = React.useState('')
  const [newKind, setNewKind] = React.useState('fact')

  const { state, reload, setState } = useAsyncState<MemoryPanelData>(
    () => loadMemory(platformApi, {
      q: applied, namespace: namespace === '' ? undefined : namespace, kind: kindFilter === '' ? undefined : kindFilter,
    }),
    [applied, namespace, kindFilter],
  )
  const mutation = useMutation()
  const afterMutation = (next: Awaited<ReturnType<typeof loadMemory>>): void => { setState(next) }

  return (
    <PlatformPanel>
      <PanelHeader
        title="我的记忆"
        subtitle="平台记忆库 + Memory Runtime(tools + bounded recall + 显式自动提取)。默认 personal/private。"
        capability="memory"
      />
      {state.status === 'ready' && state.data.runtime !== null && (
        <PanelContent>
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #5b6473)', marginBottom: 8 }}>
            {`Runtime 投影:${memoryRuntimeStateLabel(state.data.runtime.state)}`
              + ` · desired=${state.data.runtime.desiredRevision ?? '—'} observed=${state.data.runtime.observedRevision ?? '—'}`
              + ` · memories=${state.data.runtime.memoryCount}`
              + ` · recall=${state.data.runtime.recallCount}`
              + ` · team=${state.data.runtime.teamRuntime ? 'on' : 'off'}`}
          </div>
        </PanelContent>
      )}
      <PanelToolbar>
        <TextInput
          placeholder="搜索记忆内容"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') setApplied(query) }}
        />
        <button type="button" style={buttonStyle('ghost')} onClick={() => setApplied(query)}>搜索</button>
        {applied !== '' && (
          <button type="button" style={buttonStyle('ghost')} onClick={() => { setQuery(''); setApplied('') }}>清除</button>
        )}
        {mutation.pending && <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #5b6473)' }}>处理中…</span>}
      </PanelToolbar>

      <PanelContent>
        <Card>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <TextInput
              placeholder="新增记忆内容"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              style={{ minWidth: 260 }}
            />
            <Select value={newKind} onChange={(e) => setNewKind(e.target.value)}>
              {KINDS.filter((k) => k !== '').map((k) => <option key={k} value={k}>{memoryKindLabel(k)}</option>)}
            </Select>
            <Select value={namespace} onChange={(e) => setNamespace(e.target.value)}>
              <option value="">全部命名空间</option>
              {state.status !== 'loading' && state.status !== 'error' && state.data.namespaces.map((ns) => (
                <option key={ns} value={ns}>{ns}</option>
              ))}
            </Select>
            <Select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
              {KINDS.map((k) => <option key={k || 'all'} value={k}>{k === '' ? '全部类型' : memoryKindLabel(k)}</option>)}
            </Select>
            <button
              type="button"
              style={buttonStyle()}
              disabled={mutation.pending || content.trim() === ''}
              onClick={() => mutation.run(
                () => createMemoryAndReload(
                  platformApi,
                  { content: content.trim(), namespace: namespace === '' ? undefined : namespace, kind: newKind },
                  { q: applied, namespace: namespace === '' ? undefined : namespace, kind: kindFilter === '' ? undefined : kindFilter },
                ),
                (next) => { afterMutation(next); if (next.status !== 'error') setContent('') },
              )}
            >
              添加
            </button>
          </div>
        </Card>
      </PanelContent>

      {mutation.error !== null && <PanelContent><PanelError message={mutation.error} onRetry={reload} /></PanelContent>}

      <PanelContent>
        {state.status === 'loading' && <PanelLoading />}
        {state.status === 'error' && <PanelError message={state.message} onRetry={reload} />}
        {state.status === 'empty' && (
          <PanelEmpty text="暂无记忆" hint={applied !== '' ? `没有匹配「${applied}」的记忆` : '在上方添加第一条记忆'} />
        )}
        {state.status === 'ready' && state.data.records.map((record) => (
          <MemoryCard
            key={record.id}
            record={record}
            pending={mutation.pending}
            onDelete={() => mutation.run(
              () => deleteMemoryAndReload(platformApi, record.id, { q: applied, namespace: namespace === '' ? undefined : namespace, kind: kindFilter === '' ? undefined : kindFilter }),
              afterMutation,
            )}
            onPromote={() => mutation.run(
              () => promoteMemoryAndReload(platformApi, record.id, 'tenant_shared', { q: applied, namespace: namespace === '' ? undefined : namespace, kind: kindFilter === '' ? undefined : kindFilter }),
              afterMutation,
            )}
          />
        ))}
      </PanelContent>
    </PlatformPanel>
  )
}

function MemoryCard(props: {
  record: MemoryRecord
  pending: boolean
  onDelete: () => void
  onPromote: () => void
}): React.ReactElement {
  const { record } = props
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Chip>{memoryKindLabel(record.kind)}</Chip>
            <Chip>{memoryVisibilityLabel(record.visibility)}</Chip>
            <Chip>{record.namespace}</Chip>
            <Chip>{memoryExtractionLabel(record.extractionMode)}</Chip>
            {record.sourceSessionId !== null && <Chip>会话来源</Chip>}
          </div>
          <p style={{ margin: '6px 0 0', fontSize: 13, whiteSpace: 'pre-wrap' }}>{record.content}</p>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {record.visibility === 'personal' && (
            <button type="button" style={buttonStyle('ghost')} disabled={props.pending} onClick={props.onPromote}>提升为租户共享</button>
          )}
          <button type="button" style={buttonStyle('ghost')} disabled={props.pending} onClick={props.onDelete}>删除</button>
        </div>
      </div>
    </Card>
  )
}