import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigService } from '../../config/app-config.service';

/**
 * Structured JSON logging. Request/response bodies are never logged, and credentials,
 * cookies, tokens, PINs and medical fields are redacted defensively in case they appear in
 * any logged object.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.pin',
  '*.activationPin',
  '*.newPassword',
  '*.currentPassword',
  '*.recoveryCode',
  '*.resetToken',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.bloodGroup',
  '*.allergies',
  '*.medicalConditions',
  '*.medications',
  '*.emergencyNotes',
  // Phase 7 audit additions.
  'req.headers["x-recent-auth"]',
  '*.recentAuthToken',
  '*.transferCode',
  '*.credential',
  '*.credentialHash',
  '*.recoveryCodeHash',
  '*.dateOfBirth',
  '*.phone',
  '*.alternatePhone',
  '*.contacts',
  '*.pinCiphertext',
  '*.secret',
  '*.DATABASE_URL',
];

/**
 * Masks capability values in paths: the public QR token grants access to the emergency page,
 * so it is logged as `:token`; query strings are dropped entirely.
 */
export function safeLogUrl(url: string): string {
  return url
    .split('?')[0]!
    .replace(/\/(public\/emergency|public\/verify|e|verify)\/[A-Za-z0-9_-]{6,64}/g, '/$1/:token');
}

const QUIET_PATHS = new Set([
  '/api/v1/health',
  '/api/v1/health/live',
  '/api/v1/health/ready',
  '/api/v1/internal/metrics',
]);

/** pino-pretty is a dev dependency; production images run in development mode without it. */
function hasPrettyPrinter(): boolean {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
          genReqId: (req: IncomingMessage) => {
            const header = req.headers['x-request-id'];
            return typeof header === 'string' && /^[\w-]{8,64}$/.test(header)
              ? header
              : randomUUID();
          },
          customProps: () => ({ service: 'helmet-api' }),
          serializers: {
            req: (req: { id: string; method: string; url: string }) => ({
              id: req.id,
              method: req.method,
              url: safeLogUrl(req.url),
            }),
            res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
          },
          // Probes and scrapes would dominate the logs.
          autoLogging: {
            ignore: (req: IncomingMessage) => QUIET_PATHS.has((req.url ?? '').split('?')[0]!),
          },
          transport:
            config.get('NODE_ENV') === 'development' && hasPrettyPrinter()
              ? {
                  target: 'pino-pretty',
                  options: { singleLine: true, translateTime: 'SYS:HH:MM:ss' },
                }
              : undefined,
        },
      }),
    }),
  ],
})
export class LoggingModule {}
