import type { TenantContext, Skill, SkillSearchInput } from '@dsh-platform/shared'
import { randomUUID } from 'node:crypto'
import { skillRepository } from '../repositories/skill-repository.js'

export class SkillService {
  async search(ctx: TenantContext, input: SkillSearchInput): Promise<{ skills: Skill[]; total: number }> {
    return skillRepository.search(ctx, input)
  }

  async get(ctx: TenantContext, skillId: string): Promise<Skill | undefined> {
    return skillRepository.findById(ctx, skillId)
  }

  async create(ctx: TenantContext, data: {
    name: string; description?: string; prompt?: string; tools?: unknown; visibility?: string; category?: string
  }): Promise<Skill> {
    const base = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const slug = base === '' ? `skill-${randomUUID().slice(0, 8)}` : base
    return skillRepository.create(ctx, { ...data, slug, visibility: data.visibility as Skill['visibility'] })
  }

  async update(ctx: TenantContext, skillId: string, data: Partial<{
    name: string; description: string; prompt: string; tools: unknown; visibility: string; category: string
  }>): Promise<boolean> {
    return skillRepository.update(ctx, skillId, { ...data, visibility: data.visibility as Skill['visibility'] })
  }

  async publish(ctx: TenantContext, skillId: string): Promise<boolean> {
    return skillRepository.publish(ctx, skillId)
  }

  async install(ctx: TenantContext, skillId: string): Promise<boolean> {
    return skillRepository.install(ctx, skillId)
  }

  async uninstall(ctx: TenantContext, skillId: string): Promise<boolean> {
    return skillRepository.uninstall(ctx, skillId)
  }

  async listInstalled(ctx: TenantContext): Promise<Skill[]> {
    return skillRepository.listInstalled(ctx)
  }
}

export const skillService = new SkillService()