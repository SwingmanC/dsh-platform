/**
 * Skill Plaza —— dsh 浏览器端插件 bundle(platform 设计 P2)。
 *
 * 在侧边栏底部注册「技能广场」按钮,点击打开面板:
 *   - 搜索公开技能
 *   - 查看/安装技能
 *   - 创建自己的技能
 * 数据经网关 /api/skills(MySQL t_dsh_skills)。
 */
window.__ModuleLoader__.load({
  id: '@dsh-platform/dsh-skill-plaza',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { jsx, jsxs, Fragment } = require('react/jsx-runtime')

    const S = {
      trigger: {
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        padding: '8px 12px', margin: '2px 0', border: 'none', borderRadius: 6,
        background: 'transparent', cursor: 'pointer', fontSize: 13, color: 'inherit', textAlign: 'left',
      },
      overlay: {
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2147483000,
      },
      panel: {
        background: '#fff', borderRadius: 12, width: 640, maxWidth: '92vw', maxHeight: '82vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        fontFamily: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
      },
      header: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '16px 20px', borderBottom: '1px solid #eef1f6',
      },
      title: { fontSize: 16, fontWeight: 600, margin: 0, color: '#1a2744' },
      close: { background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#8a99b5', lineHeight: 1 },
      body: { padding: '16px 20px', overflowY: 'auto', flex: 1 },
      row: { display: 'flex', gap: 8, marginBottom: 12 },
      input: {
        flex: 1, padding: '9px 12px', border: '1px solid #d4dcec', borderRadius: 8,
        fontSize: 14, outline: 'none', boxSizing: 'border-box',
      },
      btn: {
        padding: '9px 16px', border: 'none', borderRadius: 8, cursor: 'pointer',
        background: 'linear-gradient(135deg,#1a6dff,#0055dd)', color: '#fff', fontSize: 14, whiteSpace: 'nowrap',
      },
      card: {
        border: '1px solid #eef1f6', borderRadius: 8, padding: '12px 14px', marginBottom: 10,
      },
      cardTitle: { fontSize: 14, fontWeight: 600, color: '#1a2744', margin: '0 0 4px' },
      cardDesc: { fontSize: 13, color: '#6b7a99', margin: 0 },
      tag: {
        display: 'inline-block', fontSize: 11, padding: '1px 8px', borderRadius: 10,
        background: '#eef4ff', color: '#1a6dff', marginTop: 6,
      },
      empty: { color: '#9aabca', fontSize: 13, textAlign: 'center', padding: '24px 0' },
    }

    function api(path, opts) {
      return fetch(path, Object.assign({ credentials: 'include' }, opts)).then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
    }

    function csrf() {
      const m = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/)
      return m ? decodeURIComponent(m[1]) : ''
    }

    function SkillPlaza() {
      const [open, setOpen] = React.useState(false)
      const [skills, setSkills] = React.useState([])
      const [q, setQ] = React.useState('')
      const [name, setName] = React.useState('')
      const [desc, setDesc] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(() => {
        const url = q.trim() ? '/api/skills/search?q=' + encodeURIComponent(q.trim()) : '/api/skills'
        api(url).then((d) => setSkills(d.skills || [])).catch(() => setSkills([]))
      }, [q])

      React.useEffect(() => { if (open) load() }, [open, load])

      const create = React.useCallback(() => {
        if (!name.trim()) return
        setBusy(true)
        api('/api/skills', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrf() },
          body: JSON.stringify({ name: name.trim(), description: desc.trim(), scope: 'public' }),
        })
          .then(() => { setName(''); setDesc(''); load() })
          .catch(() => {})
          .finally(() => setBusy(false))
      }, [name, desc, load])

      return jsxs(Fragment, {
        children: [
          jsxs('button', {
            style: S.trigger, onClick: () => setOpen(true), title: '技能广场',
            children: [jsx('span', { children: '🧩' }), jsx('span', { children: '技能广场' })],
          }),
          open
            ? jsx('div', {
                style: S.overlay,
                onClick: (e) => { if (e.target === e.currentTarget) setOpen(false) },
                children: jsxs('div', {
                  style: S.panel,
                  children: [
                    jsxs('div', {
                      style: S.header,
                      children: [
                        jsx('h2', { style: S.title, children: '技能广场' }),
                        jsx('button', { style: S.close, onClick: () => setOpen(false), children: '×' }),
                      ],
                    }),
                    jsxs('div', {
                      style: S.body,
                      children: [
                        jsxs('div', {
                          style: S.row,
                          children: [
                            jsx('input', {
                              style: S.input, placeholder: '搜索公开技能…', value: q,
                              onChange: (e) => setQ(e.target.value),
                              onKeyDown: (e) => { if (e.key === 'Enter') load() },
                            }),
                            jsx('button', { style: S.btn, onClick: load, children: '搜索' }),
                          ],
                        }),
                        skills.length === 0
                          ? jsx('div', { style: S.empty, children: '暂无技能' })
                          : skills.map((s) =>
                              jsxs('div', {
                                style: S.card,
                                children: [
                                  jsx('p', { style: S.cardTitle, children: s.name }),
                                  jsx('p', { style: S.cardDesc, children: s.description || '无描述' }),
                                  jsx('span', { style: S.tag, children: s.scope }),
                                ],
                              }),
                            ),
                        jsx('hr', { style: { border: 'none', borderTop: '1px solid #eef1f6', margin: '16px 0' } }),
                        jsx('p', { style: { fontSize: 13, fontWeight: 600, color: '#3d4f6e', margin: '0 0 8px' }, children: '创建技能' }),
                        jsxs('div', {
                          style: S.row,
                          children: [
                            jsx('input', { style: S.input, placeholder: '技能名称', value: name, onChange: (e) => setName(e.target.value) }),
                          ],
                        }),
                        jsxs('div', {
                          style: S.row,
                          children: [
                            jsx('input', { style: S.input, placeholder: '描述', value: desc, onChange: (e) => setDesc(e.target.value) }),
                            jsx('button', { style: S.btn, disabled: busy, onClick: create, children: busy ? '创建中…' : '创建' }),
                          ],
                        }),
                      ],
                    }),
                  ],
                }),
              })
            : null,
        ],
      })
    }

    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'skill-plaza', order: 110 },
          SkillPlaza,
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
