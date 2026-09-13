/**
 * 网关 API DTO(platform 设计 §8):
 * 登录/注销、工作区列表、会话列表、enter 前检查与 S1/S2 迁移的请求/响应形状。
 */
import type { Workspace } from './types.js'

export interface MeResponse {
  userId: string
  displayName: string
}

export interface WorkspaceListResponse {
  workspaces: Array<
    Workspace & {
      /** 巡检后的存在性(missingSince 为 null 即存在)。 */
      exists: boolean
    }
  >
}

export interface CreateWorkspaceRequest {
  name: string
}

export interface SessionListItem {
  sessionId: string
  title: string | null
  workspaceId: string | null
  workspace: string
  updatedAt: string
  status: string
}

export interface SessionListResponse {
  sessions: SessionListItem[]
}

export interface SessionEnterRequest {
  sessionId: string
}

/** 工作区存在 → 直接进入;缺失 → 前端弹窗引导 S1/S2(platform 设计 §6.2)。 */
export type SessionEnterResult =
  | { ok: true; sessionId: string; redirectUrl: string }
  | { ok: false; reason: 'workspace-missing'; workspace: Workspace }

export interface WorkspaceRecreateRequest {
  sessionId: string
}

export interface SessionMigrateRequest {
  sessionId: string
  mode: 'continue'
  targetWorkspaceId: string
}

export interface SessionMigrateResponse {
  ok: true
  /** S2 产生的新会话 id。 */
  newSessionId: string
  redirectUrl: string
}
