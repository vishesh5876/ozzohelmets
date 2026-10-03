import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const config = configureApp(app);
  const port = config.get('API_PORT');
  await app.listen(port, config.get('API_HOST'));
  app
    .get(Logger)
    .log(
      `API listening on :${port} (docs: ${config.get('SWAGGER_ENABLED') ? '/api/docs' : 'disabled'})`,
    );
}

void bootstrap();
