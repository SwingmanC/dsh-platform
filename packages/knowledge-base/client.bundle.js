/**
 * Knowledge Base —— dsh 浏览器端插件 bundle(platform 设计 P3)。
 *
 * 侧边栏底部「知识库」按钮 → 面板:个人/企业知识库列表 + 创建。
 * 数据经网关 /api/knowledge-bases(MySQL t_dsh_knowledge_bases)。
 */
window.__ModuleLoader__.load({
  id: '@dsh-platform/dsh-knowledge-base',
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
      card: { border: '1px solid #eef1f6', borderRadius: 8, padding: '12px 14px', marginBottom: 10 },
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

    const SCOPE_LABEL = { enterprise: '企业共享', tenant: '租户', personal: '个人' }

    function KnowledgeBase() {
      const [open, setOpen] = React.useState(false)
      const [items, setItems] = React.useState([])
      const [name, setName] = React.useState('')
      const [scope, setScope] = React.useState('personal')
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(() => {
        api('/api/knowledge-bases').then((d) => setItems(d.knowledgeBases || [])).catch(() => setItems([]))
      }, [])

      React.useEffect(() => { if (open) load() }, [open, load])

      const create = React.useCallback(() => {
        if (!name.trim()) return
        setBusy(true)
        api('/api/knowledge-bases', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrf() },
          body: JSON.stringify({ name: name.trim(), scope }),
        })
          .then(() => { setName(''); load() })
          .catch(() => {})
          .finally(() => setBusy(false))
      }, [name, scope, load])

      return jsxs(Fragment, {
        children: [
          jsxs('button', {
            style: S.trigger, onClick: () => setOpen(true), title: '知识库',
            children: [jsx('span', { children: '📚' }), jsx('span', { children: '知识库' })],
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
                        jsx('h2', { style: S.title, children: '知识库' }),
                        jsx('button', { style: S.close, onClick: () => setOpen(false), children: '×' }),
                      ],
                    }),
                    jsxs('div', {
                      style: S.body,
                      children: [
                        items.length === 0
                          ? jsx('div', { style: S.empty, children: '暂无知识库' })
                          : items.map((kb) =>
                              jsxs('div', {
                                style: S.card,
                                children: [
                                  jsx('p', { style: S.cardTitle, children: kb.name }),
                                  jsx('p', { style: S.cardDesc, children: (kb.docCount || 0) + ' 篇文档' }),
                                  jsx('span', { style: S.tag, children: SCOPE_LABEL[kb.scope] || kb.scope }),
                                ],
                              }),
                            ),
                        jsx('hr', { style: { border: 'none', borderTop: '1px solid #eef1f6', margin: '16px 0' } }),
                        jsx('p', { style: { fontSize: 13, fontWeight: 600, color: '#3d4f6e', margin: '0 0 8px' }, children: '创建知识库' }),
                        jsxs('div', {
                          style: S.row,
                          children: [
                            jsx('input', { style: S.input, placeholder: '知识库名称', value: name, onChange: (e) => setName(e.target.value) }),
                            jsx('select', {
                              style: S.input, value: scope, onChange: (e) => setScope(e.target.value),
                              children: [
                                jsx('option', { value: 'personal', children: '个人' }),
                                jsx('option', { value: 'tenant', children: '租户' }),
                                jsx('option', { value: 'enterprise', children: '企业共享' }),
                              ],
                            }),
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
          { name: 'sidebar.footer.action', id: 'knowledge-base', order: 120 },
          KnowledgeBase,
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
