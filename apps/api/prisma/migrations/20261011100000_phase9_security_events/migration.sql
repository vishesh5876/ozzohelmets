-- Phase 9: customer security events for Safety IDs (additive; existing values unchanged).
ALTER TYPE "CustomerSecurityEventType" ADD VALUE IF NOT EXISTS 'SAFETY_ID_ACTIVATED';
ALTER TYPE "CustomerSecurityEventType" ADD VALUE IF NOT EXISTS 'SAFETY_ID_TRANSFERRED_OUT';
ALTER TYPE "CustomerSecurityEventType" ADD VALUE IF NOT EXISTS 'SAFETY_ID_RECEIVED';
