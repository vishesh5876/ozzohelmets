import { Prisma } from '@prisma/client';

export function isUniqueViolation(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export function isNotFound(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

/** True when a P2002 came from the live-account email index (`users_email_normalized_live_key`). */
export function isEmailUniqueViolation(error: unknown): boolean {
  if (!isUniqueViolation(error)) return false;
  const target = (error.meta as { target?: unknown } | undefined)?.target;
  const text = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return text.includes('email_normalized') || text.includes('emailNormalized');
}
