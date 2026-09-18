import type { AuthenticatedPrincipal } from '@dsh-platform/shared'
import type { RuntimeInfo } from './supervisor.js'

declare module 'fastify' {
  interface FastifyRequest {
    /** 认证中间件注入的已验证身份。所有 handler 以此为准。 */
    principal?: AuthenticatedPrincipal
    /** CSRF 双提交 token 的服务端真值(仅写操作时由中间件验证)。 */
    csrfSecret?: string
    /** /app/* 代理预处理器解析出的用户运行时。 */
    platformRuntime?: RuntimeInfo
  }
}