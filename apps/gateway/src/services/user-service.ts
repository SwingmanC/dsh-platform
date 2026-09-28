import type { AuthenticatedPrincipal, TenantContext, UserMutationResponse, DeleteUserResponse } from '@dsh-platform/shared'
import { hashPassword } from '../auth/password.js'
import { userRepository, type UserRepository } from '../repositories/user-repository.js'
import { auditService } from '../services/audit-service.js'
import { createUserInput, passwordInput, updateUserInput, userListQuery, UserManagementError } from './user-validation.js'

export class UserService {
  constructor(
    private readonly repository: Pick<UserRepository, 'list' | 'create' | 'update' | 'remove'> = userRepository,
    private readonly stopRuntime: (userId: string) => Promise<void> = async () => {},
    private readonly audit: Pick<typeof auditService, 'write'> = auditService,
  ) {}

  private requireAdmin(actor: AuthenticatedPrincipal): void {
    if (actor.role !== 'tenant_admin') throw new UserManagementError(404, 'not-found')
  }

  private context(actor: AuthenticatedPrincipal): TenantContext {
    return { tenantId: actor.tenantId, userId: actor.userId, role: actor.role,
      requestId: actor.requestId ?? '', platformSessionId: '', deviceId: actor.deviceId }
  }

  async list(actor: AuthenticatedPrincipal, query: unknown) {
    this.requireAdmin(actor)
    return this.repository.list(actor.tenantId, userListQuery(query))
  }

  async create(actor: AuthenticatedPrincipal, body: unknown) {
    this.requireAdmin(actor)
    const { password, ...input } = createUserInput(body)
    const user = await this.repository.create(actor, input, await hashPassword(password))
    await this.audit.write({ ctx: this.context(actor), action: 'user.create', subject: user.id, payload: { role: user.role } })
    return { user, runtimeStopped: true }
  }

  async update(actor: AuthenticatedPrincipal, id: string, body: unknown): Promise<UserMutationResponse> {
    this.requireAdmin(actor)
    return this.change(actor, id, updateUserInput(body))
  }

  async resetPassword(actor: AuthenticatedPrincipal, id: string, body: unknown): Promise<UserMutationResponse> {
    this.requireAdmin(actor)
    const passwordHash = await hashPassword(passwordInput(body))
    return this.change(actor, id, {}, passwordHash)
  }

  async remove(actor: AuthenticatedPrincipal, id: string): Promise<DeleteUserResponse> {
    this.requireAdmin(actor)
    await this.repository.remove(actor, id)
    let runtimeStopped = true
    try { await this.stopRuntime(id) } catch { runtimeStopped = false }
    await this.audit.write({ ctx: this.context(actor), action: 'user.delete', subject: id, payload: { runtimeStopped } })
    return { ok: true, runtimeStopped }
  }

  private async change(actor: AuthenticatedPrincipal, id: string, input: Parameters<UserRepository['update']>[2], passwordHash?: string): Promise<UserMutationResponse> {
    const change = await this.repository.update(actor, id, input, passwordHash)
    let runtimeStopped = true
    if (change.securityChanged) {
      try { await this.stopRuntime(id) } catch { runtimeStopped = false }
    }
    if (change.changedFields.length > 0) {
      await this.audit.write({ ctx: this.context(actor), action: passwordHash ? 'user.password.reset' : 'user.update', subject: id,
        payload: { changedFields: change.changedFields, role: change.user.role, status: change.user.status, runtimeStopped } })
    }
    return { user: change.user, runtimeStopped }
  }
}
