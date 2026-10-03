import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { TEST_ENV } from './test-env';

/**
 * Brings the dedicated test database up to date with the committed migrations using the
 * non-destructive `migrate deploy` (Prisma creates the database if it is missing). Each suite
 * truncates its own data via `resetState`.
 */
export default function globalSetup(): void {
  execSync('npx prisma migrate deploy', {
    cwd: join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: TEST_ENV.DATABASE_URL },
    stdio: 'pipe',
  });
}
