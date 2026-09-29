import type { UserRole, UserStatus } from './types.js'

/** 人员管理仅返回可展示字段，不包含密码哈希或会话凭据。 */
export interface ManagedUser {
  id: string
  email: string
  displayName: string
  role: UserRole
  status: UserStatus
  createdAt: string
}

export interface UserListQuery {
  q?: string
  role?: UserRole
  status?: UserStatus
  page?: number
  pageSize?: number
}

export interface UserListResponse {
  users: ManagedUser[]
  total: number
  page: number
  pageSize: number
}

export interface CreateUserInput {
  email: string
  displayName: string
  password: string
  role: UserRole
}

export interface UpdateUserInput {
  email?: string
  displayName?: string
  role?: UserRole
  status?: UserStatus
}

export interface UserMutationResponse {
  user: ManagedUser
  /** 已撤销旧会话；当前请求所在 Gateway 的运行时是否已停止。 */
  runtimeStopped: boolean
}

export interface DeleteUserResponse {
  ok: true
  runtimeStopped: boolean
}
