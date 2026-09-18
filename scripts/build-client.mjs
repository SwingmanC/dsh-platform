/**
 * 平台 UI 插件 client bundle 构建器。
 *
 * 复刻 dsh 0.1.5-rc.2 官方约定(`packages/client/tsdown.client.ts` clientConfig):
 *   - entry: 包内 src/client/index.tsx
 *   - outDir: lib, entryFileNames: client.js
 *   - format: cjs, platform: browser
 *   - 包装: window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 *   - externals: 官方 module table baseline(react / react/jsx-runtime)
 *
 * 用法:node scripts/build-client.mjs <packageId> <entryFile> <outFile>
 */
import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [, , id, entryArg, outArg] = process.argv
if (!id || !entryArg || !outArg) {
  console.error('usage: node scripts/build-client.mjs <packageId> <entryFile> <outFile>')
  process.exit(2)
}

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const entry = resolve(repoRoot, entryArg)
const outfile = resolve(repoRoot, outArg)

/** 官方 module table baseline 中本插件可 require 的 specifier。 */
const BASELINE_EXTERNALS = ['react', 'react/jsx-runtime']

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  logLevel: 'warning',
  external: BASELINE_EXTERNALS,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  banner: {
    // 官方 clientConfig: wrapper + module/exports 前置(esbuild JS API 无 intro 选项,合入 banner)。
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  },
  footer: {
    js: 'return module.exports; } });',
  },
})

console.log(`[build-client] ${id} -> ${outArg}`)
