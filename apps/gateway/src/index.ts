import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import websocket from '@fastify/websocket'
import type { WorkspaceListResponse } from '@dsh-platform/shared'
import { ping, pool } from './db.js'
import { ensureRuntime } from './supervisor.js'

const port = Number(process.env.PORT ?? 8080)

const app = Fastify({ logger: true })
await app.register(cookie)
await app.register(websocket)

app.get('/api/health', async () => ({ ok: true, db: await ping() }))

// --- 认证(platform 设计 §3/§8):T1 接入 argon2id/OIDC + Redis sid 会话 ---
app.get('/auth/me', async (_req, reply) =>
  reply.code(501).send({ error: 'not-implemented', todo: 'T1: sid cookie -> user' }))
app.post('/auth/login', async (_req, reply) =>
  reply.code(501).send({ error: 'not-implemented', todo: 'T1: 登录 + Set-Cookie sid' }))
app.post('/auth/logout', async (_req, reply) =>
  reply.code(501).send({ error: 'not-implemented', todo: 'T1: 删会话 + 302 /login' }))

// --- 工作区列表:t_dsh_workspaces 的第一条真实读路径(鉴权随 T1 补) ---
app.get('/api/workspaces', async (): Promise<WorkspaceListResponse> => {
  const [rows] = await pool.query(
    `SELECT id, user_id AS userId, canonical_path AS canonicalPath,
            display_name AS displayName, last_used_at AS lastUsedAt, missing_since AS missingSince
       FROM t_dsh_workspaces
      ORDER BY last_used_at DESC`,
  )
  const workspaces = (rows as unknown as WorkspaceListResponse['workspaces']).map((w) => ({
    ...w,
    exists: w.missingSince === null,
  }))
  return { workspaces }
})

// --- 每用户运行时编排(platform 设计 §5/§6.4) ---
app.post('/api/runtimes/ensure', async (req, reply) => {
  const userId = (req.body as { userId?: string } | undefined)?.userId
  if (typeof userId !== 'string' || userId === '') {
    return reply.code(400).send({ error: 'userId required' })
  }
  return ensureRuntime({ userId })
})

// --- /app/* 反代占位(platform 设计 §3.2/§8):未认证 302 /login;
//     认证后代理到该用户实例(HTTP + WS),并对 401 重放 launch token 换取 Set-Cookie。 ---
app.get('/app/*', async (_req, reply) =>
  reply.code(501).send({ error: 'not-implemented', todo: 'T1: reverse proxy + launch-token exchange' }))

app.listen({ port, host: '0.0.0.0' }).then(
  () => app.log.info(`gateway listening on :${port}`),
  (err: unknown) => {
    app.log.error(err)
    process.exit(1)
  },
)
