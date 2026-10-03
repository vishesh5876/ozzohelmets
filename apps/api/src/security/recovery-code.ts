import { HELMET_CODE_ALPHABET, RECOVERY_CODE_LENGTH, RECOVERY_CODE_PREFIX } from '@helmet/types';
import { secureRandomString } from './secure-random';

/** `RK-XXXX-XXXX-XXXX`: 12 CSPRNG symbols from the unambiguous alphabet (≈ 59.4 bits). */
export function generateRecoveryCode(): string {
  const s = secureRandomString(RECOVERY_CODE_LENGTH, HELMET_CODE_ALPHABET);
  return `${RECOVERY_CODE_PREFIX}-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
