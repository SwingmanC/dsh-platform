import type { CreateUserInput, UpdateUserInput, UserListQuery, UserRole, UserStatus } from '@dsh-platform/shared'

export class UserManagementError extends Error {
  constructor(readonly statusCode: number, readonly code: string) { super(code) }
}

const roles: readonly string[] = ['tenant_admin', 'operator', 'member']
const statuses: readonly string[] = ['active', 'disabled']

function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.includes(key))) throw new UserManagementError(400, 'invalid-user-input')
  return value as Record<string, unknown>
}

function name(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 128) throw new UserManagementError(400, 'invalid-display-name')
  return value.trim()
}

function email(value: unknown): string {
  if (typeof value !== 'string') throw new UserManagementError(400, 'invalid-email')
  const normalized = value.trim().toLowerCase()
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new UserManagementError(400, 'invalid-email')
  return normalized
}

export function validatePassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128 || value.trim().length === 0) {
    throw new UserManagementError(400, 'invalid-password')
  }
  return value
}

export function createUserInput(value: unknown): CreateUserInput {
  const v = object(value, ['email', 'displayName', 'role', 'password'])
  if (typeof v.role !== 'string' || !roles.includes(v.role)) throw new UserManagementError(400, 'invalid-role')
  return { email: email(v.email), displayName: name(v.displayName), role: v.role as UserRole, password: validatePassword(v.password) }
}

export function updateUserInput(value: unknown): UpdateUserInput {
  const v = object(value, ['email', 'displayName', 'role', 'status'])
  if (Object.keys(v).length === 0) throw new UserManagementError(400, 'invalid-user-input')
  const result: UpdateUserInput = {}
  if (v.email !== undefined) result.email = email(v.email)
  if (v.displayName !== undefined) result.displayName = name(v.displayName)
  if (v.role !== undefined) {
    if (typeof v.role !== 'string' || !roles.includes(v.role)) throw new UserManagementError(400, 'invalid-role')
    result.role = v.role as UserRole
  }
  if (v.status !== undefined) {
    if (typeof v.status !== 'string' || !statuses.includes(v.status)) throw new UserManagementError(400, 'invalid-status')
    result.status = v.status as UserStatus
  }
  return result
}

export function passwordInput(value: unknown): string {
  return validatePassword(object(value, ['password']).password)
}

export function userListQuery(value: unknown): Required<Pick<UserListQuery, 'page' | 'pageSize'>> & UserListQuery {
  const v = object(value, ['q', 'role', 'status', 'page', 'pageSize'])
  const page = Number(v.page ?? 1)
  const pageSize = Number(v.pageSize ?? 20)
  if ((v.page !== undefined && typeof v.page !== 'string' && typeof v.page !== 'number')
    || (v.pageSize !== undefined && typeof v.pageSize !== 'string' && typeof v.pageSize !== 'number')
    || !Number.isSafeInteger(page) || page < 1 || page > 10000
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100
    || (v.q !== undefined && (typeof v.q !== 'string' || v.q.length > 128))
    || (v.role !== undefined && (typeof v.role !== 'string' || !roles.includes(v.role)))
    || (v.status !== undefined && (typeof v.status !== 'string' || !statuses.includes(v.status)))) throw new UserManagementError(400, 'invalid-user-query')
  return { page, pageSize, q: (v.q as string | undefined)?.trim(), role: v.role as UserRole | undefined, status: v.status as UserStatus | undefined }
}
