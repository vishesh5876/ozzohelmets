import { type INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppConfigService } from './config/app-config.service';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter';
import { httpMetricsMiddleware } from './infrastructure/metrics/http-metrics.middleware';

/**
 * Applies the HTTP pipeline shared by the real server and e2e tests:
 * /api/v1 prefix, security headers, CORS allow-list, validation, error envelope, Swagger.
 */
export function configureApp(app: NestExpressApplication): AppConfigService {
  const config = app.get(AppConfigService);

  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(httpMetricsMiddleware);
  app.setGlobalPrefix('api', { exclude: [] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.use(
    helmet({
      contentSecurityPolicy: config.get('SWAGGER_ENABLED')
        ? false // Swagger UI needs inline scripts; the API itself serves no HTML otherwise.
        : {
            useDefaults: false,
            directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
          },
      crossOriginResourcePolicy: { policy: 'same-site' },
      // HSTS is set once, at the edge proxy where TLS terminates (docs/VPS-DEPLOYMENT.md).
      strictTransportSecurity: false,
    }),
  );
  app.use(cookieParser());
  app.enableCors({
    origin: config.get('CORS_ORIGINS'),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Request-Id'],
    exposedHeaders: ['Content-Disposition', 'X-Pins-Included', 'X-Request-Id'],
    maxAge: 600,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      stopAtFirstError: false,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter(!config.isProduction));
  app.enableShutdownHooks();

  if (config.get('SWAGGER_ENABLED')) setupSwagger(app);
  return config;
}

function setupSwagger(app: INestApplication): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Helmet Platform API')
      .setDescription(
        'Helmet Emergency Identity & Product Authentication Platform. All responses use the envelope ' +
          '`{ success: true, data, meta? }` or `{ success: false, error: { code, message, details? } }`.',
      )
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'admin')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'customer')
      .build(),
  );
  SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/docs/openapi.json' });
}
