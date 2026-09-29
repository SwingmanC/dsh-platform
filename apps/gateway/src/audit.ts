/** Single public audit entrypoint. */
import { auditService, type AuditEvent } from './services/audit-service.js'
export { auditService }
export type { AuditAction, AuditEvent } from './services/audit-service.js'
export const audit = (event: AuditEvent): Promise<void> => auditService.write(event)
