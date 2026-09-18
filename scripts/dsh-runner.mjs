/**
 * dsh launcher shim:在 Node 24.0.0 上绕过 dsh 0.1.5 CLI 的 `import.meta.main` 守卫。
 * 供 E2E(PLATFORM_DSH_CLI_ENTRY)使用;生产使用真实 dsh CLI。
 */
import { pathToFileURL } from 'node:url'

const binPath = process.env.E2E_DSH_BIN ?? process.env.DSH_BIN_PATH
if (binPath === undefined || binPath === '') {
  process.stderr.write('[dsh-runner] E2E_DSH_BIN not set\n')
  process.exit(2)
}
const mod = await import(pathToFileURL(binPath).href)
process.argv = ['node', 'dsh', ...process.argv.slice(2)]
await mod.runCli()
