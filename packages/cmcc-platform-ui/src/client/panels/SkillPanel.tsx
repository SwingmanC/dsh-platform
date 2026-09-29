/**
 * Skill 面板 —— 技能广场。
 *
 * 真实平台数据(列表/搜索/创建/发布/安装/卸载);
 * Runtime Projection 状态如实展示(未接入)。
 */
import * as React from 'react'
import { platformApi } from '../platform-api.js'
import type { Skill, SkillImportPreflight } from '../models/types.js'
import {
  createSkillAndReload, installSkillAndReload, loadSkills, publishSkillAndReload,
  skillRuntimeStateLabel, skillStatusLabel, skillVisibilityLabel, unpublishSkillAndReload, uninstallSkillAndReload,
} from '../models/skills.js'
import type { SkillPanelData } from '../models/skills.js'
import { useAsyncState, useMutation } from '../components/hooks.js'
import {
  Card, Chip, PanelContent, PanelEmpty, PanelError, PanelHeader, PanelLoading,
  PanelToolbar, PlatformPanel, Select, TextInput, buttonStyle,
} from '../components/PanelShell.js'

export function SkillPanel(): React.ReactElement {
  const [query, setQuery] = React.useState('')
  const [applied, setApplied] = React.useState('')
  const [showCreate, setShowCreate] = React.useState(false)
  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [prompt, setPrompt] = React.useState('')
  const [visibility, setVisibility] = React.useState('private')
  const [catalogFor, setCatalogFor] = React.useState<string | null>(null)
  // SKILL-V1.3:Import SKILL.md(选择 → preflight 预览 → 确认导入)
  const [importFile, setImportFile] = React.useState<File | null>(null)
  const [importPreview, setImportPreview] = React.useState<SkillImportPreflight | null>(null)
  const [importMsg, setImportMsg] = React.useState<string | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)

  const runPreflight = async (file: File): Promise<void> => {
    setImportPreview(null)
    setImportMsg(null)
    try {
      setImportPreview(await platformApi.importSkillPreflight(file))
    } catch (e) {
      setImportMsg(`预检失败:${(e as Error).message}`)
    }
  }

  const onPickImportFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0] ?? null
    setImportFile(file)
    setImportPreview(null)
    setImportMsg(null)
    if (file !== null) void runPreflight(file)
  }

  const confirmImport = async (): Promise<void> => {
    if (importFile === null) return
    try {
      const skill = await platformApi.importSkill(importFile)
      setImportMsg(`已导入为草稿:${skill.name}(v${skill.latestVersion})`)
      setImportFile(null)
      setImportPreview(null)
      if (fileInputRef.current !== null) fileInputRef.current.value = ''
      reload()
    } catch (e) {
      setImportMsg(`导入失败:${(e as Error).message}`)
    }
  }

  const { state, reload, setState } = useAsyncState<SkillPanelData>(
    () => loadSkills(platformApi, { q: applied }),
    [applied],
  )
  const mutation = useMutation()

  const afterMutation = (next: Awaited<ReturnType<typeof loadSkills>>): void => {
    setState(next)
    if (next.status === 'error') return
  }

  return (
    <PlatformPanel>
      <PanelHeader
        title="技能广场"
        subtitle="平台技能注册表(DB)。已安装且已发布的技能经 cmcc-platform Provider 投影进 DSH Skill Registry。"
        capability="skill"
      />
      {state.status === 'ready' && (
        <PanelContent>
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #5b6473)', marginBottom: 8 }}>
            {state.data.runtime === null
              ? 'Runtime 投影:状态不可用'
              : `Runtime 投影:${skillRuntimeStateLabel(state.data.runtime.state)}`
                + (state.data.runtime.state === 'CONNECTED'
                  ? ` · observed=${state.data.runtime.observedRevision ?? '?'}`
                  : state.data.runtime.desiredRevision !== null
                    ? ` · desired=${state.data.runtime.desiredRevision} observed=${state.data.runtime.observedRevision ?? '—'}`
                    : '')
                + (state.data.runtime.error !== null ? ` · ${state.data.runtime.error}` : '')}
          </div>
        </PanelContent>
      )}
      <PanelToolbar>
        <TextInput
          placeholder="搜索技能名称/描述"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') setApplied(query) }}
        />
        <button type="button" style={buttonStyle('ghost')} onClick={() => setApplied(query)}>搜索</button>
        {applied !== '' && (
          <button type="button" style={buttonStyle('ghost')} onClick={() => { setQuery(''); setApplied('') }}>清除</button>
        )}
        <button type="button" style={buttonStyle()} onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? '取消' : '新建技能'}
        </button>
        <button type="button" style={buttonStyle('ghost')} onClick={() => fileInputRef.current?.click()}>
          导入 SKILL.md
        </button>
        <input ref={fileInputRef} type="file" accept=".md,.markdown,text/markdown,text/plain" style={{ display: 'none' }} onChange={onPickImportFile} />
        {mutation.pending && <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #5b6473)' }}>处理中…</span>}
      </PanelToolbar>

      {importFile !== null && (
        <PanelContent>
          <Card>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 560 }}>
              <strong style={{ fontSize: 13 }}>导入预览:{importFile.name}</strong>
              {importPreview === null && importMsg === null && <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #5b6473)' }}>预检中…</span>}
              {importPreview !== null && importPreview.valid && (
                <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span>名称:{importPreview.name}</span>
                  <span>描述:{importPreview.description}</span>
                  {importPreview.whenToUse !== null && <span>When to use:{importPreview.whenToUse}</span>}
                  <span>模型可调用:{importPreview.modelInvocable ? '是' : '否'} · 用户可调用:{importPreview.userInvocable ? '是' : '否'}</span>
                  {importPreview.warnings.length > 0 && <span>警告:{importPreview.warnings.join(';')}</span>}
                </div>
              )}
              {importPreview !== null && !importPreview.valid && (
                <span style={{ fontSize: 12, color: 'var(--dsw-alias-status-danger, #c0392b)' }}>
                  文件无效:{importPreview.errors.join(';')}
                </span>
              )}
              {importMsg !== null && (
                <span style={{ fontSize: 12, color: importMsg.startsWith('导入失败') || importMsg.startsWith('预检失败') ? 'var(--dsw-alias-status-danger, #c0392b)' : 'var(--dsw-alias-status-success, #1e7e34)' }}>{importMsg}</span>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" style={buttonStyle()} disabled={importPreview === null || !importPreview.valid} onClick={() => void confirmImport()}>
                  确认导入
                </button>
                <button type="button" style={buttonStyle('ghost')} onClick={() => { setImportFile(null); setImportPreview(null); setImportMsg(null); if (fileInputRef.current !== null) fileInputRef.current.value = '' }}>
                  取消
                </button>
              </div>
              <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary, #5b6473)' }}>导入后为草稿状态,需手动发布;同名技能会被拒绝。</span>
            </div>
          </Card>
        </PanelContent>
      )}

      {showCreate && (
        <PanelContent>
          <Card>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 520 }}>
              <TextInput placeholder="名称(必填)" value={name} onChange={(e) => setName(e.target.value)} />
              <TextInput placeholder="描述" value={description} onChange={(e) => setDescription(e.target.value)} />
              <TextInput placeholder="Prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
              <Select value={visibility} onChange={(e) => setVisibility(e.target.value)}>
                <option value="private">私有</option>
                <option value="tenant">租户</option>
                <option value="public">公开</option>
              </Select>
              <button
                type="button"
                style={buttonStyle()}
                disabled={mutation.pending || name.trim() === ''}
                onClick={() => mutation.run(
                  () => createSkillAndReload(platformApi, { name: name.trim(), description, prompt, visibility }, { q: applied }),
                  (next) => {
                    afterMutation(next)
                    if (next.status !== 'error') { setName(''); setDescription(''); setPrompt(''); setShowCreate(false) }
                  },
                )}
              >
                创建
              </button>
            </div>
          </Card>
        </PanelContent>
      )}

      {mutation.error !== null && (
        <PanelContent><PanelError message={mutation.error} onRetry={() => reload()} /></PanelContent>
      )}

      <PanelContent>
        {state.status === 'loading' && <PanelLoading />}
        {state.status === 'error' && <PanelError message={state.message} onRetry={reload} />}
        {state.status === 'empty' && (
          <PanelEmpty text="暂无技能" hint={applied !== '' ? `没有匹配「${applied}」的技能` : '点击「新建技能」创建第一个技能'} />
        )}
        {state.status === 'ready' && state.data.skills.map((skill) => (
          <SkillCard
            key={skill.id}
            skill={skill}
            installed={state.data.installedIds.includes(skill.id)}
              pending={mutation.pending}
              catalogOpen={catalogFor === skill.id}
              onToggleCatalog={() => setCatalogFor(catalogFor === skill.id ? null : skill.id)}
              onPublish={() => mutation.run(
              () => publishSkillAndReload(platformApi, skill.id, { q: applied }), afterMutation,
            )}
            onUnpublish={() => mutation.run(
              () => unpublishSkillAndReload(platformApi, skill.id, { q: applied }), afterMutation,
            )}
            onEdited={() => reload()}
            onInstall={() => mutation.run(
              () => installSkillAndReload(platformApi, skill.id, { q: applied }), afterMutation,
            )}
            onUninstall={() => mutation.run(
              () => uninstallSkillAndReload(platformApi, skill.id, { q: applied }), afterMutation,
            )}
          />
        ))}
        {state.status !== 'loading' && state.status !== 'error' && state.data.total > state.data.skills.length && (
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #5b6473)' }}>
            共 {state.data.total} 项,显示前 {state.data.skills.length} 项
          </div>
        )}
      </PanelContent>
    </PlatformPanel>
  )
}

function SkillCard(props: {
  skill: Skill
  installed: boolean
  pending: boolean
  catalogOpen: boolean
  onToggleCatalog: () => void
  onEdited: () => void
  onPublish: () => void
  onUnpublish: () => void
  onInstall: () => void
  onUninstall: () => void
}): React.ReactElement {
  const { skill } = props
  // SKILL-V1.1:作者编辑(owner-only,服务端强制;本地状态不阻塞面板)
  const [editOpen, setEditOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [draftDescription, setDraftDescription] = React.useState(skill.description ?? '')
  const [draftPrompt, setDraftPrompt] = React.useState(skill.prompt ?? '')
  const [draftWhenToUse, setDraftWhenToUse] = React.useState(skill.whenToUse ?? '')
  const [draftModelInvocable, setDraftModelInvocable] = React.useState(skill.modelInvocable ?? true)
  const [draftUserInvocable, setDraftUserInvocable] = React.useState(skill.userInvocable ?? true)
  const [saveMsg, setSaveMsg] = React.useState<string | null>(null)
  const saveEdit = async (): Promise<void> => {
    setSaving(true)
    setSaveMsg(null)
    try {
      const r = await platformApi.updateSkill(skill.id, {
        description: draftDescription, prompt: draftPrompt,
        whenToUse: draftWhenToUse || undefined,
        modelInvocable: draftModelInvocable, userInvocable: draftUserInvocable,
      })
      setSaveMsg(`已保存${r.version !== undefined ? ` · 版本 ${r.version}` : ''}`)
      props.onEdited()
    } catch (e) {
      setSaveMsg(`保存失败:${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 14 }}>{skill.name}</strong>
            <Chip>{skillStatusLabel(skill.status)}</Chip>
            <Chip>{skillVisibilityLabel(skill.visibility)}</Chip>
            <Chip>v{skill.latestVersion}</Chip>
            {props.installed && <Chip>平台已安装</Chip>}
          </div>
          {skill.description !== null && skill.description !== '' && (
            <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--dsw-alias-label-secondary, #5b6473)' }}>{skill.description}</p>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {skill.status === 'draft' && (
            <button type="button" style={buttonStyle('ghost')} disabled={props.pending} onClick={props.onPublish}>发布</button>
          )}
          {skill.status === 'published' && (
            <button type="button" style={buttonStyle('ghost')} disabled={props.pending} onClick={props.onUnpublish}>下架</button>
          )}
          {skill.isOwner === true && (
            <button type="button" style={buttonStyle('ghost')} disabled={saving || props.pending} onClick={() => setEditOpen((v) => !v)}>
              {editOpen ? '收起编辑' : '编辑'}
            </button>
          )}
          {props.installed
            ? <button type="button" style={buttonStyle('ghost')} disabled={props.pending} onClick={props.onUninstall}>卸载</button>
            : <button type="button" style={buttonStyle()} disabled={props.pending || skill.status !== 'published'} onClick={props.onInstall}>安装</button>}
        </div>
      </div>
      {editOpen && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <TextInput placeholder="描述" value={draftDescription} onChange={(e) => setDraftDescription(e.target.value)} />
          <TextInput placeholder="When to use(模型路由提示)" value={draftWhenToUse} onChange={(e) => setDraftWhenToUse(e.target.value)} />
          <textarea
            placeholder="Prompt / 技能指令正文(保存将产生新版本)"
            value={draftPrompt}
            onChange={(e) => setDraftPrompt(e.target.value)}
            rows={5}
            style={{ fontSize: 13, borderRadius: 6, border: `1px solid var(--dsw-alias-border-subtle, #d7dbe2)`, padding: '6px 10px', fontFamily: 'inherit', resize: 'vertical' }}
          />
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={draftModelInvocable} onChange={(e) => setDraftModelInvocable(e.target.checked)} />
              模型可调用
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={draftUserInvocable} onChange={(e) => setDraftUserInvocable(e.target.checked)} />
              用户可调用
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" style={buttonStyle()} disabled={saving || draftPrompt.trim() === ''} onClick={saveEdit}>
              {saving ? '保存中…' : '保存'}
            </button>
            {saveMsg !== null && <span style={{ fontSize: 12, color: saveMsg.startsWith('保存失败') ? 'var(--dsw-alias-status-danger, #c0392b)' : 'var(--dsw-alias-status-success, #1e7e34)' }}>{saveMsg}</span>}
          </div>
        </div>
      )}
    </Card>
  )
}
