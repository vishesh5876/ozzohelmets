/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  /** Local emergency services number shown on the emergency page (default 112). */
  readonly VITE_EMERGENCY_NUMBER?: string;
}
