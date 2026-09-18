/**
 * Skill 面板 —— 技能广场。
 *
 * 真实平台数据(列表/搜索/创建/发布/安装/卸载);
 * Runtime Projection 状态如实展示(未接入)。
 */
import * as React from 'react'
import { platformApi } from '../platform-api.js'
import type { Skill } from '../models/types.js'
import {
  createSkillAndReload, installSkillAndReload, loadSkills, publishSkillAndReload,
  skillRuntimeStateLabel, skillStatusLabel, skillVisibilityLabel, uninstallSkillAndReload,
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
        {mutation.pending && <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary, #5b6473)' }}>处理中…</span>}
      </PanelToolbar>

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
            onPublish={() => mutation.run(
              () => publishSkillAndReload(platformApi, skill.id, { q: applied }), afterMutation,
            )}
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
  onPublish: () => void
  onInstall: () => void
  onUninstall: () => void
}): React.ReactElement {
  const { skill } = props
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
          {props.installed
            ? <button type="button" style={buttonStyle('ghost')} disabled={props.pending} onClick={props.onUninstall}>卸载</button>
            : <button type="button" style={buttonStyle()} disabled={props.pending || skill.status !== 'published'} onClick={props.onInstall}>安装</button>}
        </div>
      </div>
    </Card>
  )
}
