/**
 * Phase 06 E2E harness:
 *   1. start the real local MCP fixture (streamable-http)
 *   2. boot the real dsh 0.1.5-rc.2 runtime with the official @deepseek-ai/dsh-mcp-client
 *      row pointing at the fixture + cmcc-mcp-observer + test-only probe
 *   3. wait for observer ack.json (ctx.tools mcp__<server>__*) and the probe's real
 *      ToolRuntime execute() result
 *
 * Env:
 *   MCP_E2E_SERVER_NAME  serverName for this runtime (default 'fixture')
 *   MCP_E2E_HOME         dsh home dir (default var/e2e-mcp-home)
 *   MCP_E2E_PROJ         projection dir (default var/e2e-proj)
 *   MCP_E2E_DSH_PORT     dsh web port (default 3180)
 *   MCP_E2E_FIXTURE_PORT fixture port (default 9099)
 *
 * Exit 0 on success; prints observed ack + tool-call result.
 */
import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFixture } from '../apps/mcp-fixture/dist/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const serverName = process.env.MCP_E2E_SERVER_NAME ?? 'fixture'
const home = process.env.MCP_E2E_HOME ? path.resolve(process.env.MCP_E2E_HOME) : path.join(repoRoot, 'var', 'e2e-mcp-home')
const projDir = process.env.MCP_E2E_PROJ ? path.resolve(process.env.MCP_E2E_PROJ) : path.join(repoRoot, 'var', 'e2e-proj')
const dshPort = process.env.MCP_E2E_DSH_PORT ?? '3180'
const fixturePort = Number(process.env.MCP_E2E_FIXTURE_PORT ?? '9099')
const secretEnv = process.env.MCP_E2E_SECRET_ENV ?? ''
const secretValue = process.env.MCP_E2E_SECRET_VALUE ?? ''
const ackFile = path.join(projDir, 'ack.json')
const probeFile = path.join(projDir, 'probe.json')
const harness = process.env.DSH_HARNESS ?? 'C:/Users/10543/AppData/Local/Temp/opencode/dsh-run.mjs'
const binPath = path.join(repoRoot, '.tools', 'dsh-0.1.5-rc.2', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const patch = path.join(home, 'profiles', 'web', 'platform-patch.yml')
const observerSrc = path.join(repoRoot, 'packages', 'cmcc-mcp-observer')

// Deploy observer (+probe) into the home, and write the patch for this serverName.
await mkdir(path.join(home, 'profiles', 'web'), { recursive: true })
await mkdir(path.join(projDir), { recursive: true })
await mkdir(path.join(home, 'node_modules', '@dsh-platform', 'cmcc-mcp-observer'), { recursive: true })
await cp(path.join(observerSrc, 'lib'), path.join(home, 'node_modules', '@dsh-platform', 'cmcc-mcp-observer', 'lib'), { recursive: true })
await cp(path.join(observerSrc, 'package.json'), path.join(home, 'node_modules', '@dsh-platform', 'cmcc-mcp-observer', 'package.json'))
const headersYaml = secretEnv !== '' && secretValue !== ''
  ? `        headers:\n          Authorization: !!js '\`Bearer \${process.env.${secretEnv}}\`'`
  : '        headers: {}'
await writeFile(patch, `# Phase 06 E2E patch (auto-generated)
- insert:
    - id: "@dsh-platform/cmcc-mcp-observer"
      name: "@dsh-platform/cmcc-mcp-observer"
    - id: "cmcc-mcp-probe"
      name: "@dsh-platform/cmcc-mcp-observer/probe"
    - id: "cmcc-mcp-${serverName}"
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: "${serverName}"
        transport: streamable-http
        url: "http://127.0.0.1:${fixturePort}/mcp"
${headersYaml}
        toolCallTimeoutMs: 60000
        failOnStartupError: false
`, 'utf8')
await writeFile(path.join(projDir, 'status.json'), JSON.stringify({ desiredRevision: `${serverName}-rev`, generatedAt: new Date().toISOString(), serverCount: 1 }), 'utf8')
await rm(ackFile, { force: true }).catch(() => undefined)
await rm(probeFile, { force: true }).catch(() => undefined)

if (secretValue !== '') process.env.MCP_FIXTURE_TOKEN = secretValue
const fixture = await startFixture(fixturePort)
process.stderr.write(`[e2e:${serverName}] fixture up at ${fixture.url}\n`)

const child = spawn(process.execPath, [
  harness, '--patch', patch, '--profile', 'web', '--no-open',
  '--host', '127.0.0.1', '--port', dshPort, '--trusted-host', 'localhost:8080',
], {
  cwd: home,
  env: {
    ...process.env,
    DSH_BIN_PATH: binPath,
    DSH_HOME: home,
    PLATFORM_MCP_PROJECTION_DIR: projDir,
    PLATFORM_MCP_PROBE_OUT: probeFile,
    PLATFORM_MCP_PROBE_TOOL: `mcp__${serverName}__cmcc_marker`,
    ...(secretEnv !== '' && secretValue !== '' ? { [secretEnv]: secretValue } : {}),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

let out = ''
child.stdout.on('data', (c) => { out += c.toString() })
child.stderr.on('data', (c) => { out += c.toString() })

let ack = null
let probe = null
const deadline = Date.now() + 90_000
while (Date.now() < deadline) {
  try {
    const parsed = JSON.parse(await readFile(ackFile, 'utf8'))
    if (Array.isArray(parsed.servers) && parsed.servers.some((s) => s.toolCount > 0)) ack = parsed
  } catch { /* not ready */ }
  try { probe = JSON.parse(await readFile(probeFile, 'utf8')) } catch { /* not ready */ }
  if (ack !== null && probe !== null) break
  await new Promise((r) => setTimeout(r, 1000))
}

child.kill()
await fixture.close()

if (ack === null) {
  process.stderr.write(`[e2e:${serverName}] FAIL: no mcp tools observed\n--- dsh output ---\n${out}\n`)
  process.exit(1)
}
process.stdout.write(`[e2e:${serverName}] OBSERVED: ${JSON.stringify(ack)}\n`)

if (probe === null || probe.ok !== true) {
  process.stderr.write(`[e2e:${serverName}] FAIL: probe did not complete\n${JSON.stringify(probe)}\n--- dsh output ---\n${out}\n`)
  process.exit(1)
}
const text = JSON.stringify(probe.result)
if (!text.includes('CMCC_MCP_FIXTURE_06')) {
  process.stderr.write(`[e2e:${serverName}] FAIL: marker not found\n${text}\n`)
  process.exit(1)
}
process.stdout.write(`[e2e:${serverName}] TOOL CALL MARKER OK: ${text}\n`)

// Secret leak scan: the injected credential must never appear in the generated patch or logs.
if (secretValue !== '') {
  const patchContent = await readFile(patch, 'utf8')
  const hitsPatch = patchContent.includes(secretValue)
  const hitsLog = out.includes(secretValue)
  if (hitsPatch || hitsLog) {
    process.stderr.write(`[e2e:${serverName}] FAIL: secret leaked (patch=${hitsPatch} log=${hitsLog})\n`)
    process.exit(1)
  }
  process.stdout.write(`[e2e:${serverName}] SECRET LEAK SCAN: 0 hits (patch+logs); credential accepted via env injection\n`)
}
process.exit(0)