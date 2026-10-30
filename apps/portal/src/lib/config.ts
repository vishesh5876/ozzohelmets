export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';
export const EMERGENCY_NUMBER = import.meta.env.VITE_EMERGENCY_NUMBER ?? '112';
/**
 * Ownership transfers (give a helmet / Safety ID to someone, claim one with a Transfer Code).
 * Hidden by default to keep the owner flow simple: activate → set password → done. The API keeps
 * supporting them; set VITE_TRANSFERS_ENABLED=true to show the buttons again.
 */
export const TRANSFERS_ENABLED = import.meta.env.VITE_TRANSFERS_ENABLED === 'true';
/**
 * "My helmets" and "Warranty" (helmet records, warranty registration, linked product). Hidden by
 * default: owners only manage their Safety IDs. The API keeps them; set VITE_HELMETS_ENABLED=true
 * to show the pages again.
 */
export const HELMETS_ENABLED = import.meta.env.VITE_HELMETS_ENABLED === 'true';
/**
 * Emailed one-time codes at sign-up and email change. On by default (the API enforces it with
 * EMAIL_VERIFICATION_REQUIRED); 'false' only for test setups where the API does not require it.
 */
export const EMAIL_VERIFICATION_ENABLED = import.meta.env.VITE_EMAIL_VERIFICATION !== 'false';
