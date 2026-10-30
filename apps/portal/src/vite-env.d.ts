/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  /** Local emergency services number shown on the emergency page (default 112). */
  readonly VITE_EMERGENCY_NUMBER?: string;
  /** 'true' shows ownership transfer / claim in the portal (hidden by default). */
  readonly VITE_TRANSFERS_ENABLED?: string;
  /** 'false' hides the emailed-code step (test setups only; the API decides what is required). */
  readonly VITE_EMAIL_VERIFICATION?: string;
}
