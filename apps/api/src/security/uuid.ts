import { randomBytes } from 'node:crypto';

/**
 * RFC 9562 UUIDv7 (48-bit ms timestamp + 74 random bits). Used when IDs must be known before
 * insert (bulk generation links helmets, escrow and history rows in one transaction).
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = 0x70 | ((bytes[6] as number) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] as number) & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
