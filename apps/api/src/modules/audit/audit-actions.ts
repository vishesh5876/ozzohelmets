/** Canonical audit action names. Keep stable: they are queried and reported on. */
export const AuditAction = {
  ADMIN_LOGIN_SUCCEEDED: 'admin.login.succeeded',
  ADMIN_LOGIN_FAILED: 'admin.login.failed',
  ADMIN_LOGIN_LOCKED: 'admin.login.locked',
  ADMIN_LOGOUT: 'admin.logout',
  ADMIN_REFRESH_REUSE_DETECTED: 'admin.refresh.reuse_detected',
  ADMIN_USER_CREATED: 'admin_user.created',
  ADMIN_USER_UPDATED: 'admin_user.updated',
  HELMET_MODEL_CREATED: 'helmet_model.created',
  HELMET_MODEL_UPDATED: 'helmet_model.updated',
  BATCH_CREATED: 'batch.created',
  BATCH_GENERATION_STARTED: 'batch.generation.started',
  BATCH_GENERATION_COMPLETED: 'batch.generation.completed',
  BATCH_GENERATION_FAILED: 'batch.generation.failed',
  BATCH_MARKED_PRINTED: 'batch.marked_printed',
  BATCH_PIN_ESCROW_PURGED: 'batch.pin_escrow.purged',
  BATCH_EXPORT_MANUFACTURING_CSV: 'batch.export.manufacturing_csv',
  HELMET_STATUS_CHANGED: 'helmet.status.changed',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];
