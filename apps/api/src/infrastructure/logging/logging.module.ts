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
  '*.otp',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.bloodGroup',
  '*.allergies',
  '*.medicalConditions',
  '*.medications',
  '*.emergencyNotes',
];

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
              // Strip query strings; public tokens in paths are acceptable (non-secret identifiers).
              url: req.url.split('?')[0],
            }),
            res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
          },
          autoLogging: { ignore: (req: IncomingMessage) => req.url === '/api/v1/health' },
          transport:
            config.get('NODE_ENV') === 'development'
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
