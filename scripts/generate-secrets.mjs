#!/usr/bin/env node
// Prints freshly generated values for every secret in .env.example.
import { randomBytes } from 'node:crypto';

const str = (bytes) => randomBytes(bytes).toString('base64url');
const key = () => randomBytes(32).toString('base64');

console.log(`JWT_ACCESS_SECRET=${str(48)}
PIN_HASH_PEPPER=${str(48)}
PIN_ESCROW_KEYS=v1:${key()}
DATA_ENCRYPTION_KEYS=v1:${key()}
IP_HASH_SECRET=${str(48)}
POSTGRES_PASSWORD=${str(24)}`);
