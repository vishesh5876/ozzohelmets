import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { AesGcmCipher } from './encryption';

/**
 * Purpose-separated ciphers so a compromise or rotation of one key does not affect the other.
 * - `pinEscrow`: temporary activation-PIN escrow for manufacturing exports.
 * - `data`: application-level encryption of sensitive personal/medical fields (Phase 2).
 * Decrypted values must never be logged.
 */
@Injectable()
export class EncryptionService {
  readonly pinEscrow: AesGcmCipher;
  readonly data: AesGcmCipher;

  constructor(config: AppConfigService) {
    this.pinEscrow = new AesGcmCipher(config.get('PIN_ESCROW_KEYS'));
    this.data = new AesGcmCipher(config.get('DATA_ENCRYPTION_KEYS'));
  }
}
