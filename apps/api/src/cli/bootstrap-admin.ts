import type { INestApplicationContext } from '@nestjs/common';
import { AdminRole } from '@helmet/types';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { AuditService } from '../modules/audit/audit.service';
import { AuditAction } from '../modules/audit/audit-actions';
import { HashingService } from '../security/hashing.service';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const ADMIN_PASSWORD_RULE = /(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/;

export interface BootstrapInput {
  email: string;
  name: string;
  password: string;
}

/**
 * Creates the first SUPER_ADMIN. Refuses when any SUPER_ADMIN already exists (it is a one-time
 * bootstrap, not a backdoor). The password comes from stdin, never from argv or the env file.
 */
export async function bootstrapAdmin(
  app: INestApplicationContext,
  input: BootstrapInput,
): Promise<string> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email)) throw new Error('A valid --email is required.');
  if (input.name.trim().length < 2)
    throw new Error('A --name of at least 2 characters is required.');
  if (
    input.password.length < 12 ||
    input.password.length > 128 ||
    !ADMIN_PASSWORD_RULE.test(input.password)
  )
    throw new Error(
      'Password must be 12–128 characters with upper and lower case letters and a digit.',
    );
  const prisma = app.get(PrismaService);
  const existing = await prisma.adminUser.count({ where: { role: AdminRole.SUPER_ADMIN } });
  if (existing > 0)
    throw new Error('A SUPER_ADMIN already exists. Create further admins from the admin console.');
  const passwordHash = await app.get(HashingService).hashPassword(input.password);
  const admin = await prisma.adminUser.create({
    data: { email, name: input.name.trim(), role: AdminRole.SUPER_ADMIN, passwordHash },
  });
  await app.get(AuditService).record({
    action: AuditAction.ADMIN_USER_CREATED,
    entityType: 'admin_user',
    entityId: admin.id,
    metadata: { role: AdminRole.SUPER_ADMIN, via: 'bootstrap-cli' },
  });
  return admin.id;
}
