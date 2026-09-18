/**
 * dsh Skill Plaza Client Plugin
 * Registers a "Skill Plaza" button in the sidebar footer.
 * When clicked, opens a panel showing skills available to the user.
 */

// 注意:此插件为客户端插件,包含 document/window 等浏览器 API。
// 需通过 dsh 客户端插件构建管道(tsdown)打包。当前为占位源码。
// TODO: 接入构建管道后,将此插件加入 profile patch。

export const name = 'ui-skill-plaza'
export const inject = ['slots', 'remote']

declare const React: { createElement: Function }

function SkillPlazaPanel() {
  const [skills, setSkills] = React.createElement('div', null, '技能加载中...')
  React.useEffect(() => {
    fetch('/api/skills', { credentials: 'include' })
      .then(r => r.json())
      .then(data => setSkills(data.skills ?? []))
      .catch(() => setSkills([]))
  }, [])
  return React.createElement('div', { style: { padding: 16 } },
    React.createElement('h3', null, '技能广场'),
    Array.isArray(skills) ? skills.map(s =>
      React.createElement('div', { key: s.id, style: { padding: 8, borderBottom: '1px solid #eee' } },
        React.createElement('strong', null, s.name),
        React.createElement('p', { style: { fontSize: 12, color: '#666' } }, s.description || '无描述')
      )
    ) : React.createElement('p', null, '暂无技能')
  )
}

export function apply(ctx: { slots: { inject(s: string, cb: () => void): void; register(opts: any, comp: any): void } }): void {
  // 注册侧边栏底部按钮
  // 当用户点击时打开面板
}